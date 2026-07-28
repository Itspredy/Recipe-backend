import { fetchMetadata } from './source.js';

/**
 * Pluggable "get the caption + media for a social post" layer.
 *
 * The app's core feature is Instagram/TikTok → recipe, and self-hosted yt-dlp
 * gets blocked from datacenter IPs. So for social links we prefer a MANAGED
 * SCRAPER (Apify by default — it runs the residential proxies and anti-bot
 * arms race for us) and fall back to yt-dlp (which still works for YouTube).
 *
 * Each fetcher returns a normalised shape or null:
 *   { caption, title, author, thumbnail, videoUrl }
 * `videoUrl`, when present, is a direct media URL we can download for
 * transcription without touching yt-dlp again.
 *
 * Swapping providers (EnsembleData, ScrapeCreators, a RapidAPI actor, …) is a
 * new function with the same return shape — nothing else changes.
 */

const APIFY_BASE = 'https://api.apify.com/v2/acts';

// Actor ids are configurable so you can pin a different/known-good scraper.
const ACTORS = {
  instagram: process.env.APIFY_IG_ACTOR || 'apify~instagram-scraper',
  tiktok: process.env.APIFY_TIKTOK_ACTOR || 'clockworks~free-tiktok-scraper',
};

function actorInput(platform, url) {
  if (platform === 'instagram') {
    return { directUrls: [url], resultsType: 'posts', resultsLimit: 1, addParentData: false };
  }
  if (platform === 'tiktok') {
    return { postURLs: [url], resultsPerPage: 1, shouldDownloadVideos: false, shouldDownloadCovers: false };
  }
  return null;
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
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(`Apify ${platform} fetch failed (${res.status})`);
  }

  const items = await res.json();
  const item = Array.isArray(items) ? items[0] : null;
  if (!item) return null;

  return {
    caption: String(pick(item, ['caption', 'text', 'description']) ?? ''),
    title: String(pick(item, ['title', 'caption', 'text']) ?? ''),
    author: pick(item, ['ownerUsername', 'ownerFullName', 'authorMeta.name', 'authorMeta.nickName', 'author']),
    thumbnail: pick(item, ['displayUrl', 'videoMeta.coverUrl', 'covers.default', 'thumbnailUrl', 'coverUrl', 'images.0']),
    videoUrl: pick(item, ['videoUrl', 'videoUrlNoWaterMark', 'mediaUrls.0', 'videoMeta.downloadAddr', 'downloadAddr']),
  };
}

/** yt-dlp path — reliable for YouTube, a best-effort fallback for IG/TikTok. */
export async function ytdlpFetch(url) {
  const meta = await fetchMetadata(url);
  return {
    caption: meta.caption ?? '',
    title: meta.title ?? '',
    author: meta.author ?? null,
    thumbnail: meta.thumbnail ?? null,
    videoUrl: null,
  };
}

/**
 * Resolve a social post to caption/media, trying the managed scraper first and
 * yt-dlp second. Returns { source, provider } or throws if every fetcher fails
 * (so the caller can surface the manual-paste fallback).
 */
export async function fetchSource(url, platform) {
  const errors = [];

  if (platform === 'instagram' || platform === 'tiktok') {
    try {
      const source = await apifyFetch(url, platform);
      if (source && (source.caption || source.videoUrl)) return { source, provider: 'apify' };
    } catch (err) {
      errors.push(`apify: ${err.message}`);
      console.warn('[fetchSource] apify failed:', err.message);
    }
  }

  try {
    const source = await ytdlpFetch(url);
    if (source && (source.caption || source.title)) return { source, provider: 'yt-dlp' };
  } catch (err) {
    errors.push(`yt-dlp: ${err.message}`);
    console.warn('[fetchSource] yt-dlp failed:', err.message);
  }

  const error = new Error(
    'That link is blocked or unavailable. Paste the caption text instead and we’ll read it.',
  );
  error.status = 502;
  error.detail = errors.join('; ');
  throw error;
}
