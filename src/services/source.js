import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import youtubedl from 'youtube-dl-exec';

const run = promisify(execFile);

/**
 * Extra yt-dlp options from the environment. A residential/mobile proxy is the
 * single biggest lever for getting IG/TikTok to work from a cloud host, and a
 * cookies file (a logged-in session export) is effectively required for most
 * Instagram content. Both are optional — unset means "plain yt-dlp".
 */
function ytdlpEnvOpts() {
  const opts = {};
  if (process.env.YTDLP_PROXY) opts.proxy = process.env.YTDLP_PROXY;
  if (process.env.YTDLP_COOKIES) opts.cookies = process.env.YTDLP_COOKIES;
  return opts;
}

/**
 * Pulls whatever we can get from a social video URL without paying for anything:
 * the caption/description, a thumbnail, the author, and (optionally) the audio
 * track for transcription.
 */

export function detectPlatform(url) {
  const host = new URL(url).hostname.replace(/^www\./, '');
  if (host.includes('instagram.com')) return 'instagram';
  if (host.includes('tiktok.com')) return 'tiktok';
  if (host.includes('youtube.com') || host.includes('youtu.be')) return 'youtube';
  if (host.includes('facebook.com') || host.includes('fb.watch')) return 'facebook';
  return 'web';
}

export async function fetchMetadata(url) {
  const info = await youtubedl(url, {
    dumpSingleJson: true,
    noWarnings: true,
    noCheckCertificates: true,
    preferFreeFormats: true,
    ...ytdlpEnvOpts(),
  });

  return {
    caption: info.description ?? '',
    title: info.title ?? '',
    author: info.uploader ?? info.channel ?? info.uploader_id ?? null,
    thumbnail: info.thumbnail ?? null,
    durationSeconds: info.duration ?? null,
  };
}

/**
 * Downloads audio to a temp file and returns the contents plus a cleanup
 * function — the caller is responsible for calling it, and nothing here
 * touches permanent storage.
 *
 * Some Instagram/TikTok reels only expose a video-only stream (music baked
 * into the video, no separate audio track), so we let yt-dlp download the
 * best available and then use ffmpeg to extract audio if present. If there
 * is no audio at all we return null so the caller can fall back to
 * caption-only structuring instead of failing the whole import.
 *
 * Whisper only needs the audio and Groq rejects large uploads, so we always
 * re-encode to a small mono MP3 — a 30-60s clip shrinks to well under 1MB.
 */
export async function downloadAudio(url) {
  const dir = await mkdtemp(join(tmpdir(), 'recipe-import-'));

  // Any error between here and the successful return deletes the temp dir, so a
  // downloaded video is never left on disk — nothing persists past this call.
  try {
    const rawOutput = join(dir, 'raw.%(ext)s');

    await youtubedl(url, {
      format: 'bestaudio/best',
      output: rawOutput,
      noWarnings: true,
      noCheckCertificates: true,
      ...ytdlpEnvOpts(),
    });

    const { readdir } = await import('node:fs/promises');
    const files = await readdir(dir);
    const rawPath = join(dir, files[0]);
    const compressedPath = join(dir, 'audio.mp3');

    // Probe for an audio stream first — running ffmpeg on a video-only file
    // wastes ~20s of CPU and then crashes with "Output file #0 does not
    // contain any stream". Check up front instead.
    const { stdout: streamKinds } = await run('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a',
      '-show_entries', 'stream=codec_type',
      '-of', 'default=nw=1:nk=1',
      rawPath,
    ]);

    if (!streamKinds.trim()) {
      await rm(dir, { recursive: true, force: true });
      return null;
    }

    await run('ffmpeg', [
      '-y',
      '-i', rawPath,
      '-vn', // drop any video stream
      '-ac', '1', // mono
      '-ar', '16000', // Whisper's native sample rate
      '-b:a', '48k', // low bitrate is plenty for speech
      compressedPath,
    ]);

    return {
      buffer: await readFile(compressedPath),
      filename: 'audio.mp3',
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Downloads a direct media URL (the one a managed scraper hands back) and
 * extracts a small mono MP3 for Whisper — same output contract as downloadAudio,
 * but no yt-dlp involved. Returns null when the media has no audio track.
 */
export async function downloadAudioFromUrl(mediaUrl) {
  const dir = await mkdtemp(join(tmpdir(), 'recipe-import-'));

  // Same guarantee as downloadAudio: the temp dir is deleted on every path,
  // so the fetched video is gone the moment we're done (or if anything fails).
  try {
    const rawPath = join(dir, 'raw.mp4');
    const compressedPath = join(dir, 'audio.mp3');

    const res = await fetch(mediaUrl);
    if (!res.ok) throw new Error(`media download failed (${res.status})`);
    await writeFile(rawPath, Buffer.from(await res.arrayBuffer()));

    const { stdout: streamKinds } = await run('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a',
      '-show_entries', 'stream=codec_type',
      '-of', 'default=nw=1:nk=1',
      rawPath,
    ]);

    if (!streamKinds.trim()) {
      await rm(dir, { recursive: true, force: true });
      return null;
    }

    await run('ffmpeg', ['-y', '-i', rawPath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', compressedPath]);

    return {
      buffer: await readFile(compressedPath),
      filename: 'audio.mp3',
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Heuristic: does the caption already contain the full recipe?
 *
 * Recipe creators very often paste ingredients straight into the caption so
 * viewers can copy them. When they have, we can skip transcription entirely —
 * saving both the API cost and ~3 seconds of latency.
 */
export function captionLooksComplete(caption) {
  if (!caption || caption.length < 150) return false;

  const measurements = caption.match(
    /\b\d+([.,/]\d+)?\s*(g|kg|ml|l|oz|lb|lbs|tsp|tbsp|cup|cups|clove|cloves|slice|slices|pinch)\b/gi,
  );
  const hasQuantities = (measurements?.length ?? 0) >= 4;
  const hasStructure = /ingredients?\s*:|method\s*:|instructions?\s*:|step\s*1/i.test(caption);

  return hasQuantities && (hasStructure || (measurements?.length ?? 0) >= 6);
}
