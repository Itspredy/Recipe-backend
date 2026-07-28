import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import { categorise } from './services/categories.js';
import { structureRecipe, transcribe } from './services/ai.js';
import { captionLooksComplete, detectPlatform, downloadAudio, downloadAudioFromUrl } from './services/source.js';
import { fetchSource } from './services/fetchers.js';
import { parseRecipeWebsite } from './services/website.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

/**
 * In-memory dedupe. A viral reel gets imported by many users; processing it once
 * and replaying the result makes repeats instant and free. This resets on
 * restart — swap for Redis or a table when you deploy for real.
 */
const cache = new Map();

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/import', async (req, res) => {
  const { url } = req.body ?? {};

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing "url".' });
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return res.status(400).json({ error: 'That is not a valid link.' });
  }

  const key = parsedUrl.href;
  if (cache.has(key)) {
    return res.json({ ...cache.get(key), cached: true });
  }

  try {
    const result = await importRecipe(parsedUrl.href);
    cache.set(key, result);
    res.json({ ...result, cached: false });
  } catch (error) {
    console.error('[import] failed:', error);
    res.status(error.status ?? 500).json({
      error: error.status ? error.message : "Couldn't read a recipe from that link.",
    });
  }
});

/**
 * Manual fallback: the user pastes the caption / recipe text (e.g. copied from a
 * reel we couldn't scrape) and Groq structures it. This is the escape hatch that
 * means an import can never hard-fail on the user.
 */
app.post('/structure', async (req, res) => {
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

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  console.log(`Recipe import server listening on http://localhost:${port}`);
});
