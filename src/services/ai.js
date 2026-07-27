import Groq from 'groq-sdk';
import { toFile } from 'groq-sdk';

let client;

function groq() {
  if (!client) {
    if (!process.env.GROQ_API_KEY) {
      throw new Error('GROQ_API_KEY is missing — copy .env.example to .env and fill it in.');
    }
    client = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }
  return client;
}

export async function transcribe({ buffer, filename }) {
  const file = await toFile(buffer, filename);
  const result = await groq().audio.transcriptions.create({
    file,
    model: process.env.TRANSCRIBE_MODEL || 'whisper-large-v3-turbo',
    response_format: 'text',
  });
  return typeof result === 'string' ? result : (result.text ?? '');
}

const SYSTEM_PROMPT = `You turn cooking-video transcripts and captions into structured recipes.

Return ONLY a JSON object with exactly this shape:
{
  "title": string,
  "description": string,
  "servings": number,
  "prepMinutes": number | null,
  "cookMinutes": number | null,
  "ingredients": [{ "quantity": number | null, "unit": string | null, "name": string, "note": string | null }],
  "steps": [{ "text": string }],
  "tags": [string]
}

Rules:
- "quantity" is a decimal number. Convert fractions: 1/2 -> 0.5, "1 1/2" -> 1.5. Use null if no amount is given.
- "unit" is a short lowercase unit ("g", "ml", "tbsp", "tsp", "cup", "clove", "slice"). Use null for countable items like "3 eggs".
- "name" is the bare ingredient with no amount and no preparation ("yellow onion", not "3 yellow onions, thinly sliced").
- Preparation detail goes in "note" ("thinly sliced").
- Steps must be complete, actionable sentences in cooking order. Merge fragmented speech into coherent instructions.
- Infer sensible prep/cook times when the source implies them; use null when there is genuinely no signal.
- Never invent ingredients that are not mentioned or clearly visible in the source text.
- If the source is not a recipe at all, return {"error": "not_a_recipe"}.`;

export async function structureRecipe({ caption, transcript, title }) {
  const sources = [
    title && `VIDEO TITLE:\n${title}`,
    caption && `CAPTION:\n${caption}`,
    transcript && `AUDIO TRANSCRIPT:\n${transcript}`,
  ]
    .filter(Boolean)
    .join('\n\n---\n\n');

  const completion = await groq().chat.completions.create({
    model: process.env.STRUCTURE_MODEL || 'llama-3.3-70b-versatile',
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: sources },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? '{}';
  const parsed = JSON.parse(raw);

  if (parsed.error === 'not_a_recipe') {
    const err = new Error("That link doesn't look like a recipe.");
    err.status = 422;
    throw err;
  }

  return normalise(parsed);
}

/** Guards against the model returning slightly-off shapes. */
function normalise(recipe) {
  const num = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };

  return {
    title: String(recipe.title ?? 'Untitled recipe').trim(),
    description: String(recipe.description ?? '').trim(),
    servings: num(recipe.servings) ?? 2,
    prepMinutes: num(recipe.prepMinutes),
    cookMinutes: num(recipe.cookMinutes),
    ingredients: (Array.isArray(recipe.ingredients) ? recipe.ingredients : [])
      .filter((i) => i && i.name)
      .map((i) => ({
        quantity: num(i.quantity),
        unit: i.unit ? String(i.unit).trim() : null,
        name: String(i.name).trim(),
        note: i.note ? String(i.note).trim() : null,
      })),
    steps: (Array.isArray(recipe.steps) ? recipe.steps : [])
      .map((s) => (typeof s === 'string' ? s : s?.text))
      .filter(Boolean)
      .map((text) => ({ text: String(text).trim() })),
    tags: (Array.isArray(recipe.tags) ? recipe.tags : []).map(String),
  };
}
