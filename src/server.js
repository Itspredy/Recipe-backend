import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import { categorise } from './services/categories.js';
import { structureRecipe, transcribe } from './services/ai.js';
import { captionLooksComplete, detectPlatform, downloadAudio, fetchMetadata } from './services/source.js';
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

  const metadata = await fetchMetadata(url);

  // Skip the paid transcription step when the caption already spells out the recipe.
  let transcript = '';
  const needsAudio = !captionLooksComplete(metadata.caption);

  if (needsAudio) {
    const audio = await downloadAudio(url);
    try {
      transcript = await transcribe(audio);
    } finally {
      await audio.cleanup();
    }
  }

  const recipe = await structureRecipe({
    caption: metadata.caption,
    transcript,
    title: metadata.title,
  });

  return buildResponse({
    recipe,
    thumbnail: metadata.thumbnail,
    sourceUrl: url,
    platform,
    author: metadata.author,
    usedTranscription: needsAudio,
  });
}

function buildResponse({ recipe, thumbnail, sourceUrl, platform, author, usedTranscription }) {
  return {
    ...recipe,
    ingredients: recipe.ingredients.map((ingredient) => ({
      ...ingredient,
      category: categorise(ingredient.name),
    })),
    imageUrl: thumbnail,
    sourceUrl,
    sourcePlatform: platform,
    sourceAuthor: author,
    usedTranscription,
  };
}

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  console.log(`Recipe import server listening on http://localhost:${port}`);
});
