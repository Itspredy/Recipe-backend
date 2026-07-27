import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import youtubedl from 'youtube-dl-exec';

const run = promisify(execFile);

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
 * Platforms like Instagram often don't expose an audio-only stream, so
 * yt-dlp falls back to the full video. Whisper only needs the audio, and
 * Groq rejects large uploads, so we always re-encode through ffmpeg to a
 * small mono MP3 — a 30-60s clip shrinks from potentially tens of MB down
 * to under 1MB, comfortably inside any API's size limit.
 */
export async function downloadAudio(url) {
  const dir = await mkdtemp(join(tmpdir(), 'recipe-import-'));
  const rawOutput = join(dir, 'raw.%(ext)s');

  await youtubedl(url, {
    format: 'bestaudio[ext=m4a]/bestaudio/best',
    output: rawOutput,
    noWarnings: true,
    noCheckCertificates: true,
  });

  const { readdir } = await import('node:fs/promises');
  const [rawFilename] = await readdir(dir);
  const rawPath = join(dir, rawFilename);
  const compressedPath = join(dir, 'audio.mp3');

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
