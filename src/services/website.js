import * as cheerio from 'cheerio';

/**
 * Most recipe blogs embed schema.org/Recipe as JSON-LD. When they do we can build
 * the whole recipe from the markup — no transcription, no LLM call, no cost.
 */
export async function parseRecipeWebsite(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; RecipeImporter/1.0)' },
  });
  if (!response.ok) return null;

  const $ = cheerio.load(await response.text());

  for (const element of $('script[type="application/ld+json"]').toArray()) {
    let json;
    try {
      json = JSON.parse($(element).contents().text());
    } catch {
      continue;
    }

    const recipe = findRecipeNode(json);
    if (recipe) return { recipe: fromJsonLd(recipe), thumbnail: imageUrl(recipe.image) };
  }

  return null;
}

/** JSON-LD arrives as a bare object, an array, or wrapped in an @graph. */
function findRecipeNode(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findRecipeNode(item);
      if (found) return found;
    }
    return null;
  }
  const type = node['@type'];
  const isRecipe = Array.isArray(type) ? type.includes('Recipe') : type === 'Recipe';
  if (isRecipe) return node;
  if (node['@graph']) return findRecipeNode(node['@graph']);
  return null;
}

function fromJsonLd(node) {
  return {
    title: String(node.name ?? 'Untitled recipe').trim(),
    description: stripHtml(String(node.description ?? '')),
    servings: parseServings(node.recipeYield),
    prepMinutes: parseDuration(node.prepTime),
    cookMinutes: parseDuration(node.cookTime ?? node.totalTime),
    // Website ingredient strings are unstructured ("2 tbsp olive oil"), so we
    // parse the leading amount off the front rather than calling a model.
    ingredients: toArray(node.recipeIngredient).map(parseIngredientLine),
    steps: parseInstructions(node.recipeInstructions),
    tags: toArray(node.recipeCuisine).concat(toArray(node.recipeCategory)).map(String),
  };
}

const UNITS = [
  'g', 'kg', 'ml', 'l', 'oz', 'lb', 'lbs', 'tsp', 'teaspoon', 'teaspoons',
  'tbsp', 'tablespoon', 'tablespoons', 'cup', 'cups', 'clove', 'cloves',
  'slice', 'slices', 'pinch', 'can', 'cans', 'stick', 'sticks',
];

function parseIngredientLine(line) {
  const text = String(line).trim();
  const match = text.match(
    new RegExp(`^([\\d\\s./¼½¾⅓⅔]+)?\\s*(${UNITS.join('|')})?\\.?\\s+(.*)$`, 'i'),
  );

  if (!match) return { quantity: null, unit: null, name: text, note: null };

  const [, rawQuantity, rawUnit, rest] = match;
  const [name, ...noteParts] = rest.split(',');

  return {
    quantity: parseQuantity(rawQuantity),
    unit: rawUnit ? rawUnit.toLowerCase() : null,
    name: name.trim(),
    note: noteParts.length ? noteParts.join(',').trim() : null,
  };
}

const VULGAR_FRACTIONS = { '¼': 0.25, '½': 0.5, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3 };

function parseQuantity(raw) {
  if (!raw) return null;
  let total = 0;
  for (const token of raw.trim().split(/\s+/)) {
    if (VULGAR_FRACTIONS[token] !== undefined) total += VULGAR_FRACTIONS[token];
    else if (token.includes('/')) {
      const [n, d] = token.split('/').map(Number);
      if (d) total += n / d;
    } else {
      const n = Number(token.replace(',', '.'));
      if (Number.isFinite(n)) total += n;
    }
  }
  return total > 0 ? Math.round(total * 100) / 100 : null;
}

/** ISO 8601 durations, e.g. PT1H30M -> 90 */
function parseDuration(value) {
  if (!value) return null;
  const match = String(value).match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!match) return null;
  const minutes = Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0);
  return minutes > 0 ? minutes : null;
}

function parseServings(value) {
  const n = Number(String(toArray(value)[0] ?? '').replace(/\D/g, ''));
  return Number.isFinite(n) && n > 0 ? n : 2;
}

function parseInstructions(value) {
  return toArray(value)
    .flatMap((item) => {
      if (typeof item === 'string') return [item];
      if (item?.['@type'] === 'HowToSection') return toArray(item.itemListElement).map((s) => s.text);
      return [item?.text];
    })
    .filter(Boolean)
    .map((text) => ({ text: stripHtml(String(text)) }));
}

function imageUrl(image) {
  const first = toArray(image)[0];
  if (!first) return null;
  return typeof first === 'string' ? first : (first.url ?? null);
}

const toArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);
const stripHtml = (html) => cheerio.load(html).text().trim();
