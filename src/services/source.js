import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import youtubedl from 'youtube-dl-exec';

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
 * Downloads just the audio track to a temp file. Returns the file contents plus
 * a cleanup function — the caller is responsible for calling it, and the file
 * never touches permanent storage.
 */
export async function downloadAudio(url) {
  const dir = await mkdtemp(join(tmpdir(), 'recipe-import-'));
  const output = join(dir, 'audio.%(ext)s');

  await youtubedl(url, {
    format: 'bestaudio[ext=m4a]/bestaudio/best',
    output,
    noWarnings: true,
    noCheckCertificates: true,
  });

  const { readdir } = await import('node:fs/promises');
  const [filename] = await readdir(dir);
  const path = join(dir, filename);

  return {
    buffer: await readFile(path),
    filename,
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
