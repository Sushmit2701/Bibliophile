// AI helpers. Uses Google's Gemini API (free tier) with *your own* key, called
// directly from the browser. The key is stored only on this device.
// Everything here also has a no-AI fallback so the app works without a key.
import { db, save, getBook, itemsForBook, fmtRating, STATUSES } from './store.js';

const API = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_MODEL = 'gemini-2.5-flash';

export const hasAI = () => !!db.settings.geminiKey;

async function call(model, prompt, key) {
  const res = await fetch(`${API}/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.7 } }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const err = new Error(data.error?.message || `Gemini error ${res.status}`); err.status = res.status; throw err; }
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('').trim();
  if (!text) throw new Error('The AI returned an empty answer (it may have been blocked). Try again.');
  return text;
}

// If the saved model name has been retired, find a current "flash" model automatically.
async function pickModel(key) {
  const res = await fetch(`${API}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
  const data = await res.json();
  const names = (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace('models/', ''))
    .filter((n) => /flash/.test(n) && !/(lite|image|tts|audio|live|exp|preview|thinking)/.test(n))
    .sort().reverse();
  return names[0];
}

export async function ask(prompt) {
  const key = db.settings.geminiKey;
  if (!key) throw new Error('Add a free Gemini API key in Settings to use AI.');
  const model = db.settings.geminiModel || DEFAULT_MODEL;
  try {
    return await call(model, prompt, key);
  } catch (e) {
    if (e.status !== 404) throw e;
    const next = await pickModel(key);
    if (!next || next === model) throw e;
    db.settings.geminiModel = next; save();
    return call(next, prompt, key);
  }
}

export async function testKey(key) {
  const model = db.settings.geminiModel || DEFAULT_MODEL;
  try { await call(model, 'Reply with the single word: ready', key); return model; }
  catch (e) {
    if (e.status !== 404) throw e;
    const next = await pickModel(key);
    if (!next) throw e;
    await call(next, 'Reply with the single word: ready', key);
    return next;
  }
}

// ---------- Voice-note tidying ----------
const FILLERS = /\b(um+|uh+|erm+|uhm+|you know|i mean|kind of like|sort of like|like,)\s*/gi;

// No-AI cleanup: strip filler words, collapse repeats, capitalise sentences.
export function tidyLocally(text) {
  let t = ' ' + text.replace(FILLERS, '').replace(/\s+/g, ' ').trim() + ' ';
  t = t.replace(/\b(\w+)( \1\b)+/gi, '$1'); // "the the" -> "the"
  t = t.replace(/ i /g, ' I ').replace(/ i'(m|ve|d|ll) /g, " I'$1 ");
  t = t.trim();
  t = t.replace(/(^|[.!?]\s+)([a-z])/g, (m, a, b) => a + b.toUpperCase());
  if (t && !/[.!?]$/.test(t)) t += '.';
  return t;
}

export async function tidyReview(text, book) {
  return ask(`You are editing a reader's spoken voice-note review of a book into clean written prose.
Book: "${book.title}"${book.author ? ` by ${book.author}` : ''}.
Rules:
- Keep their voice, opinions and wording wherever possible. Do not add opinions, facts or praise they didn't say.
- Remove filler words, false starts and repetition; fix punctuation and grammar; split into short paragraphs.
- First person. No headings, no bullet points, no preamble — return only the tidied review.

Voice note transcript:
"""${text}"""`);
}

// ---------- Social content from saved quotes ----------
function bookContext(book) {
  const items = itemsForBook(book.id).filter((i) => i.kind !== 'word' && i.text);
  const ranked = items.slice().sort((a, b) => (b.favorite - a.favorite) || (a.text.length - b.text.length));
  return { items, ranked };
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

export function hashtags(book) {
  const tags = ['booktok', 'bookstagram', 'bookquotes', 'reading', slug(book.title), slug(book.author || '')]
    .concat((book.tags || []).map(slug))
    .filter((t) => t && t.length < 30);
  return [...new Set(tags)].slice(0, 10).map((t) => '#' + t).join(' ');
}

const ratingLine = (b) => (b.rating ? `${'★'.repeat(Math.floor(b.rating))}${b.rating % 1 ? '½' : ''} (${fmtRating(b.rating)}/5)` : '');

// Template versions — free, instant, work offline.
export function captionTemplate(book) {
  const { ranked } = bookContext(book);
  const top = ranked.slice(0, 3);
  const firstLine = top[0] ? `“${top[0].text}”` : `Just finished ${book.title}.`;
  const lines = [
    firstLine,
    '',
    `${book.status === 'finished' ? 'Finished' : 'Reading'} ${book.title}${book.author ? ` by ${book.author}` : ''}${book.rating ? ` — ${ratingLine(book)}` : ''}.`,
  ];
  const firstPara = (book.review || '').split(/\n\s*\n/)[0].trim();
  if (firstPara) lines.push('', firstPara);
  if (top.length > 1) {
    lines.push('', 'Lines I underlined:');
    top.slice(1).forEach((i) => lines.push(`— “${i.text}”`));
  }
  lines.push('', 'Have you read it? Tell me your favourite line 👇', '', hashtags(book));
  return lines.join('\n');
}

export function reelTemplate(book) {
  const { ranked } = bookContext(book);
  const quotes = ranked.filter((i) => i.text.length < 220).slice(0, 4);
  const use = quotes.length ? quotes : ranked.slice(0, 3);
  let t = 0;
  const beat = (secs, onScreen, voice) => { const s = `[${t}–${t + secs}s]`; t += secs; return `${s}\nON SCREEN: ${onScreen}${voice ? `\nVOICEOVER: ${voice}` : ''}\n`; };
  const out = [
    `REEL SCRIPT — ${book.title}${book.author ? ` by ${book.author}` : ''}`,
    `Length: ~${8 + use.length * 5}s · Format: 9:16 · Suggested visuals: the book on a table, slow page turns, warm light`,
    '',
    beat(3, `“${use.length} lines from ${book.title} I can't stop thinking about”`, `${use.length} lines from ${book.title} that stayed with me.`),
  ];
  use.forEach((i, n) => out.push(beat(5, `${n + 1}. “${i.text}”${i.page ? `  (p. ${i.page})` : ''}`, i.note ? i.note : '')));
  out.push(beat(3, book.rating ? `My rating: ${ratingLine(book)}` : `Would you read it?`, book.review ? (book.review.split(/[.!?]/)[0] + '.').trim() : 'Would you read it?'));
  out.push(beat(2, 'Save this for your TBR 📚', 'Save this for later.'));
  out.push('', 'AUDIO: soft piano or lo-fi, low volume under the voiceover', '', 'CAPTION:', captionTemplate(book));
  return out.join('\n');
}

function quotesBlock(book) {
  return bookContext(book).ranked.slice(0, 12).map((i) => `- "${i.text}"${i.page ? ` (p. ${i.page})` : ''}${i.favorite ? ' [favourite]' : ''}${i.note ? ` — my note: ${i.note}` : ''}`).join('\n');
}

export function aiCaption(book) {
  return ask(`Write an Instagram/Threads caption for a reader sharing a book they're reading.
Book: "${book.title}"${book.author ? ` by ${book.author}` : ''}. Status: ${STATUSES[book.status] || book.status}.${book.rating ? ` Their rating: ${fmtRating(book.rating)}/5.` : ''}
${book.review ? `Their review (use their opinions, don't invent new ones):\n${book.review}\n` : ''}Quotes they saved:
${quotesBlock(book)}

Rules: open with a strong hook line (a quote or a striking thought), 80–150 words, warm and personal, first person, quote exactly as given, end with a question to invite comments, then a line of 6–10 relevant hashtags. Return only the caption.`);
}

export function aiReel(book) {
  return ask(`Write a short-form video (Instagram Reel / TikTok / YouTube Short) script for a reader sharing a book.
Book: "${book.title}"${book.author ? ` by ${book.author}` : ''}.${book.rating ? ` Their rating: ${fmtRating(book.rating)}/5.` : ''}
${book.review ? `Their review (use their opinions, don't invent new ones):\n${book.review}\n` : ''}Quotes they saved:
${quotesBlock(book)}

Format, plain text, no markdown:
- A title line, then the total length (20–40 seconds) and suggested visuals.
- Timed beats like "[0–3s]", each with "ON SCREEN:" text and optional "VOICEOVER:".
- Beat 1 is a scroll-stopping hook. Use 2–4 of the quotes word for word. End with a call to action.
- Then "AUDIO:" with a music mood, then "CAPTION:" with a short caption and 6–10 hashtags.`);
}
