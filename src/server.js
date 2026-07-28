import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import { categorise } from './services/categories.js';
import { structureRecipe, transcribe } from './services/ai.js';
import { captionLooksComplete, detectPlatform, downloadAudio, downloadAudioFromUrl } from './services/source.js';
import { fetchSource } from './services/fetchers.js';
import { parseRecipeWebsite } from './services/website.js';
import { cacheGet, cacheSet, cacheStatus, closeCache, initCache } from './lib/cache.js';
import { limiterStatus, rateLimit } from './lib/limiter.js';
import { assertSafePublicUrl } from './lib/url.js';

const app = express();

// Behind Railway's proxy: needed for the forwarded client IP the limiter uses.
app.set('trust proxy', 1);

// The app is a native client, so a wildcard origin is the sane default. Set
// ALLOWED_ORIGINS to lock the browser build down to known hosts.
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
app.use(cors(allowedOrigins.length ? { origin: allowedOrigins } : {}));

// Requests are a URL or a pasted caption — 50mb was an abuse vector, not a need.
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ limit: '256kb', extended: true }));

// An import can legitimately take a while (scrape + transcribe + structure) but
// must not hang a worker forever.
const IMPORT_TIMEOUT_MS = Number(process.env.IMPORT_TIMEOUT_MS ?? 120_000);

app.get('/health', (_req, res) =>
  res.json({
    ok: true,
    groq: Boolean(process.env.GROQ_API_KEY),
    apify: Boolean(process.env.APIFY_TOKEN),
    cache: cacheStatus(),
    limits: limiterStatus(),
  }),
);

app.post('/import', rateLimit, async (req, res) => {
  const { url } = req.body ?? {};

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing "url".' });
  }

  try {
    // Validates the scheme, blocks private/internal addresses, and canonicalises
    // the link so shares of the same post collapse onto one cache entry.
    const key = await assertSafePublicUrl(url);

    const hit = await cacheGet(key);
    if (hit) return res.json({ ...hit, cached: true });

    const result = await withDeadline(importRecipe(key), IMPORT_TIMEOUT_MS);
    await cacheSet(key, result);
    res.json({ ...result, cached: false });
  } catch (error) {
    console.error('[import] failed:', error.message, error.detail ? `(${error.detail})` : '');
    res.status(error.status ?? 500).json({
      error: error.status ? error.message : "Couldn't read a recipe from that link.",
    });
  }
});

function withDeadline(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => {
        const error = new Error('That link took too long. Paste the caption text instead.');
        error.status = 504;
        reject(error);
      }, ms),
    ),
  ]);
}

/**
 * Manual fallback: the user pastes the caption / recipe text (e.g. copied from a
 * reel we couldn't scrape) and Groq structures it. This is the escape hatch that
 * means an import can never hard-fail on the user.
 */
app.post('/structure', rateLimit, async (req, res) => {
  const { text, title } = req.body ?? {};

  if (!text || typeof text !== 'string' || text.trim().length < 20) {
    return res.status(400).json({ error: 'Paste the recipe text — ingredients and steps.' });
  }

  try {
    const recipe = await structureRecipe({ caption: text, transcript: '', title: title ?? '' });
    res.json(
      buildResponse({
        recipe,
        thumbnail: null,
        sourceUrl: null,
        platform: 'manual',
        author: null,
        usedTranscription: false,
        provider: 'manual',
      }),
    );
  } catch (error) {
    console.error('[structure] failed:', error);
    res.status(error.status ?? 500).json({
      error: error.status ? error.message : "Couldn't read a recipe from that text.",
    });
  }
});

async function importRecipe(url) {
  const platform = detectPlatform(url);

  // Recipe blogs: the markup usually has everything, so no AI is needed at all.
  if (platform === 'web') {
    const parsed = await parseRecipeWebsite(url);
    if (parsed) {
      return buildResponse({
        recipe: parsed.recipe,
        thumbnail: parsed.thumbnail,
        sourceUrl: url,
        platform,
        author: new URL(url).hostname.replace(/^www\./, ''),
        usedTranscription: false,
      });
    }
  }

  // Social links: prefer a managed scraper (survives IG/TikTok blocks from a
  // cloud host), fall back to yt-dlp. Throws with a manual-paste hint if both
  // fail, which the app surfaces as "paste the caption instead".
  const { source, provider } = await fetchSource(url, platform);

  // Skip the paid transcription step when the caption already spells out the recipe.
  let transcript = '';
  let usedTranscription = false;
  const needsAudio = !captionLooksComplete(source.caption);

  if (needsAudio) {
    // Prefer the direct media URL the scraper handed us; otherwise let yt-dlp
    // pull the audio. Either can return null (music-only / no audio), in which
    // case we fall through to caption-only structuring rather than failing.
    let audio = null;
    try {
      audio = source.videoUrl ? await downloadAudioFromUrl(source.videoUrl) : await downloadAudio(url);
      if (audio) {
        transcript = await transcribe(audio);
        usedTranscription = true;
      }
    } catch (err) {
      console.warn('[import] transcription skipped:', err.message);
    } finally {
      if (audio) await audio.cleanup();
    }
  }

  const recipe = await structureRecipe({
    caption: source.caption,
    transcript,
    title: source.title,
  });

  return buildResponse({
    recipe,
    thumbnail: source.thumbnail,
    sourceUrl: url,
    platform,
    author: source.author,
    usedTranscription,
    provider,
  });
}

function buildResponse({ recipe, thumbnail, sourceUrl, platform, author, usedTranscription, provider }) {
  return {
    ...recipe,
    ingredients: recipe.ingredients.map((ingredient) => ({
      ...ingredient,
      category: categorise(ingredient.name),
    })),
    imageUrl: thumbnail ?? null,
    sourceUrl: sourceUrl ?? null,
    sourcePlatform: platform,
    sourceAuthor: author ?? null,
    usedTranscription: usedTranscription ?? false,
    provider: provider ?? null,
  };
}

// A bad response from a provider shouldn't be able to take the whole service
// down; log loudly and keep serving.
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

const port = Number(process.env.PORT ?? 8787);

await initCache();

const server = app.listen(port, () => {
  console.log(`Recipe import server listening on http://localhost:${port}`);
  console.log(`  groq: ${process.env.GROQ_API_KEY ? 'configured' : 'MISSING'}`);
  console.log(`  apify: ${process.env.APIFY_TOKEN ? 'configured' : 'not set (yt-dlp only)'}`);
  console.log(`  cache: ${cacheStatus().backend}`);
});

// Railway sends SIGTERM on redeploy: stop accepting, drain, release the pool.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`[${signal}] shutting down`);
    server.close(async () => {
      await closeCache();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
