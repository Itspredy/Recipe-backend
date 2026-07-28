import { fetchMetadata } from './source.js';

/**
 * Pluggable "get the caption + media for a social post" layer.
 *
 * Order matters, and it is deliberately cheapest-first:
 *
 *   1. yt-dlp          free. Works from residential IPs and (today) for
 *                      Instagram from our host. Also lets us pull audio later.
 *   2. YouTube page    free. YouTube blocks yt-dlp from datacenter IPs, but a
 *                      plain HTML GET of the watch page still yields the
 *                      description. YouTube-only.
 *   3. Apify           paid managed scraper. Runs residential proxies and the
 *                      anti-bot arms race for us. Only billed when the free
 *                      tiers above fail.
 *
 * If every tier fails we throw, and the app offers "paste the caption instead".
 *
 * Each fetcher returns a normalised shape or null:
 *   { caption, title, author, thumbnail, videoUrl, canFetchAudio }
 *
 * `videoUrl`  — direct media URL we can download for transcription.
 * `canFetchAudio` — true when yt-dlp itself can pull the audio for this url.
 *
 * Swapping providers (EnsembleData, ScrapeCreators, a RapidAPI actor, …) is a
 * new function with the same return shape — nothing else changes.
 */

const APIFY_BASE = 'https://api.apify.com/v2/acts';

// Actor ids are configurable so you can pin a different/known-good scraper.
const ACTORS = {
  instagram: process.env.APIFY_IG_ACTOR || 'apify~instagram-scraper',
  tiktok: process.env.APIFY_TIKTOK_ACTOR || 'clockworks~free-tiktok-scraper',
  youtube: process.env.APIFY_YT_ACTOR || 'streamers~youtube-scraper',
};

const YTDLP_TIMEOUT_MS = Number(process.env.YTDLP_TIMEOUT_MS ?? 25_000);
const APIFY_TIMEOUT_MS = Number(process.env.APIFY_TIMEOUT_MS ?? 90_000);
const HTML_TIMEOUT_MS = 12_000;

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** Reject a hung fetcher so we fall through to the next tier promptly. */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

/** First defined value among dot-path candidates. */
function pick(obj, paths) {
  for (const path of paths) {
    const value = path.split('.').reduce((o, key) => (o == null ? o : o[key]), obj);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

/**
 * Is this result good enough to build a recipe from? A fetcher that returns
 * only a title is useless — without a caption, a media URL, or the ability to
 * pull audio there is nothing for the model to read, so we keep falling back.
 */
function isUsable(source) {
  if (!source) return false;
  const caption = (source.caption ?? '').trim();
  const transcript = (source.transcript ?? '').trim();
  return (
    caption.length >= 40 ||
    transcript.length >= 40 ||
    Boolean(source.videoUrl) ||
    Boolean(source.canFetchAudio)
  );
}

// ── Tier 1: yt-dlp (free) ───────────────────────────────────────────────────

/** Reliable for YouTube/Instagram from residential IPs; free everywhere. */
export async function ytdlpFetch(url) {
  const meta = await withTimeout(fetchMetadata(url), YTDLP_TIMEOUT_MS, 'yt-dlp');
  return {
    caption: meta.caption ?? '',
    title: meta.title ?? '',
    author: meta.author ?? null,
    thumbnail: meta.thumbnail ?? null,
    videoUrl: null,
    // yt-dlp answered, so it can almost certainly fetch the audio too.
    canFetchAudio: true,
  };
}

// ── Tier 2: YouTube watch page (free) ───────────────────────────────────────

/**
 * YouTube serves the video metadata inside the watch page as a big JSON blob
 * (`ytInitialPlayerResponse`). A plain browser-like GET usually succeeds even
 * from a datacenter IP, where yt-dlp's innertube calls get bot-walled.
 *
 * Gives us the description but no downloadable media, so it only helps when the
 * description actually contains the recipe.
 */
export async function youtubePageFetch(url) {
  const res = await withTimeout(
    fetch(url, { headers: { 'user-agent': BROWSER_UA, 'accept-language': 'en-US,en;q=0.9' } }),
    HTML_TIMEOUT_MS,
    'youtube page',
  );
  if (!res.ok) throw new Error(`youtube page fetch failed (${res.status})`);

  const html = await res.text();
  const match = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*(?:var|const|let|<\/script>)/s);
  if (!match) return null;

  let details;
  try {
    details = JSON.parse(match[1])?.videoDetails;
  } catch {
    return null;
  }
  if (!details) return null;

  const thumbs = details.thumbnail?.thumbnails;
  return {
    caption: details.shortDescription ?? '',
    title: details.title ?? '',
    author: details.author ?? null,
    thumbnail: Array.isArray(thumbs) && thumbs.length ? thumbs[thumbs.length - 1].url : null,
    videoUrl: null,
    canFetchAudio: false,
  };
}

// ── Tier 3: Apify managed scraper (paid) ────────────────────────────────────

function actorInput(platform, url) {
  if (platform === 'instagram') {
    return { directUrls: [url], resultsType: 'posts', resultsLimit: 1, addParentData: false };
  }
  if (platform === 'tiktok') {
    return { postURLs: [url], resultsPerPage: 1, shouldDownloadVideos: false, shouldDownloadCovers: false };
  }
  if (platform === 'youtube') {
    // Subtitles are the whole point of this tier. YouTube auto-captions almost
    // every video, so asking for them gives us the spoken recipe as text —
    // which fixes videos that have no description at all, and costs nothing
    // extra: no audio download, no Whisper call.
    // 'any' language matters: plenty of recipe videos aren't in English.
    return {
      startUrls: [{ url }],
      maxResults: 1,
      downloadSubtitles: true,
      subtitlesLanguage: 'any',
      subtitlesFormat: 'plaintext',
      preferAutoGeneratedSubtitles: true,
    };
  }
  return null;
}

/**
 * Subtitle payloads vary by actor version: an array of {language, plaintext},
 * a bare string, or an srt blob. Pull readable text out of whatever we get and
 * strip any timing/index lines that survive from srt.
 */
function extractSubtitleText(raw) {
  const candidates = Array.isArray(raw) ? raw : raw ? [raw] : [];

  for (const entry of candidates) {
    const text =
      typeof entry === 'string'
        ? entry
        : (entry?.plaintext ?? entry?.text ?? entry?.srt ?? entry?.vtt ?? entry?.content ?? null);
    if (typeof text !== 'string' || text.trim().length < 20) continue;

    const cleaned = text
      .split('\n')
      .filter((line) => !/^\d+$/.test(line.trim()))
      .filter((line) => !/^\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->/.test(line.trim()))
      .filter((line) => !/^WEBVTT/i.test(line.trim()))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (cleaned.length >= 20) return cleaned;
  }
  return '';
}

/**
 * Managed-scraper fetch via Apify's synchronous run endpoint. Returns null when
 * not configured or unsupported so the caller can fall back cleanly. Throws only
 * on a real API error, which the caller logs and swallows.
 */
export async function apifyFetch(url, platform) {
  const token = process.env.APIFY_TOKEN;
  const actor = ACTORS[platform];
  const input = actorInput(platform, url);
  if (!token || !actor || !input) return null;

  const endpoint = `${APIFY_BASE}/${actor}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;
  const res = await withTimeout(
    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
    APIFY_TIMEOUT_MS,
    'apify',
  );
  if (!res.ok) {
    throw new Error(`Apify ${platform} fetch failed (${res.status})`);
  }

  const items = await res.json();
  const item = Array.isArray(items) ? items[0] : null;
  if (!item) return null;

  return {
    caption: String(pick(item, ['caption', 'text', 'description']) ?? ''),
    title: String(pick(item, ['title', 'caption', 'text']) ?? ''),
    author: pick(item, ['ownerUsername', 'ownerFullName', 'authorMeta.name', 'authorMeta.nickName', 'channelName', 'author']),
    thumbnail: pick(item, ['displayUrl', 'videoMeta.coverUrl', 'covers.default', 'thumbnailUrl', 'coverUrl', 'thumbnails.0.url', 'images.0']),
    videoUrl: pick(item, ['videoUrl', 'videoUrlNoWaterMark', 'mediaUrls.0', 'videoMeta.downloadAddr', 'downloadAddr', 'downloadUrl']),
    // Already-transcribed speech, when the platform provides captions. Saves
    // both the media download and the Whisper call downstream.
    transcript: extractSubtitleText(pick(item, ['subtitles', 'captions', 'subtitle'])),
    canFetchAudio: false,
  };
}

// ── The chain ───────────────────────────────────────────────────────────────

/**
 * Resolve a social post to caption/media, cheapest source first.
 * Returns { source, provider }, or throws so the caller can surface the
 * manual-paste fallback.
 */
export async function fetchSource(url, platform) {
  const errors = [];

  const tiers = [
    { name: 'yt-dlp', run: () => ytdlpFetch(url) },
    ...(platform === 'youtube' ? [{ name: 'youtube-page', run: () => youtubePageFetch(url) }] : []),
    { name: 'apify', run: () => apifyFetch(url, platform) },
  ];

  for (const tier of tiers) {
    try {
      const source = await tier.run();
      if (isUsable(source)) {
        console.log(`[fetchSource] ${platform} resolved via ${tier.name}`);
        return { source, provider: tier.name };
      }
      if (source) errors.push(`${tier.name}: no usable caption or media`);
    } catch (err) {
      errors.push(`${tier.name}: ${err.message}`);
      console.warn(`[fetchSource] ${tier.name} failed:`, err.message);
    }
  }

  const error = new Error(
    'That link is blocked or unavailable. Paste the caption text instead and we’ll read it.',
  );
  error.status = 502;
  error.detail = errors.join('; ');
  throw error;
}
