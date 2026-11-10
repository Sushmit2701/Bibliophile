// Local-first data store. Everything lives in localStorage on this device.
// Use Settings → Backup to export/import a JSON file.

const KEY = 'bibliophile:v1';

export const KINDS = {
  highlight: { label: 'Highlight', icon: '❝' },
  quote: { label: 'Quote', icon: '“' },
  note: { label: 'Note', icon: '✎' },
  idea: { label: 'Idea', icon: '💡' },
  question: { label: 'Question', icon: '?' },
  word: { label: 'Word', icon: 'Aa' },
};

// Optional detailed rating: each aspect is scored 1–5 and together they suggest an overall rating.
export const ASPECTS = {
  writing: { label: 'Writing', hint: 'prose, style, craft' },
  substance: { label: 'Story & ideas', hint: 'plot or argument, originality' },
  feeling: { label: 'Emotional pull', hint: 'how much it gripped or moved you' },
  staying: { label: 'Staying power', hint: 'will you still think about it in a year?' },
};

export function suggestedRating(aspects) {
  const vals = Object.values(aspects || {}).filter((v) => v > 0);
  if (!vals.length) return 0;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 2) / 2; // nearest half star
}

export const fmtRating = (n) => (n % 1 ? n.toFixed(1) : String(n));

export const STATUSES = {
  want: 'Want to read',
  reading: 'Reading',
  finished: 'Finished',
  paused: 'Paused',
  abandoned: 'Did not finish',
};

const defaults = () => ({
  version: 1,
  books: [],
  items: [],
  settings: { yearlyGoal: 24, dailyReview: 5, theme: 'auto', name: '' },
  reviewLog: {}, // { 'YYYY-MM-DD': number of items reviewed }
});

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const d = JSON.parse(raw);
    const base = defaults();
    return { ...base, ...d, settings: { ...base.settings, ...(d.settings || {}) } };
  } catch {
    return defaults();
  }
}

export const db = load();
const listeners = new Set();

export function onChange(fn) { listeners.add(fn); }

// quiet: store without redrawing the page (for background bookkeeping like AI usage counts).
export function save({ quiet = false } = {}) {
  db.updatedAt = new Date().toISOString();
  try {
    localStorage.setItem(KEY, JSON.stringify(db));
  } catch (e) {
    alert('Could not save — storage may be full. Please export a backup. ' + e.message);
  }
  if (!quiet) listeners.forEach((fn) => fn());
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
export const today = () => localDate(new Date());
export function localDate(d) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}
export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + Math.round(n));
  return localDate(d);
}

// ---------- Books ----------
export const getBook = (id) => db.books.find((b) => b.id === id);

export function upsertBook(data) {
  const now = new Date().toISOString();
  let book = data.id && getBook(data.id);
  if (book) {
    const wasFinished = book.status === 'finished';
    Object.assign(book, data, { updatedAt: now });
    if (book.status === 'finished' && !wasFinished && !book.finishedAt) book.finishedAt = today();
    if (book.status === 'reading' && !book.startedAt) book.startedAt = today();
  } else {
    book = {
      id: uid(), title: '', author: '', cover: '', isbn: '', pages: 0, year: '',
      status: 'want', rating: 0, tags: [], format: 'print', currentPage: 0,
      startedAt: '', finishedAt: '', review: '', sessions: [],
      createdAt: now, updatedAt: now, ...data,
    };
    if (!data.id) book.id = uid();
    if (book.status === 'reading' && !book.startedAt) book.startedAt = today();
    if (book.status === 'finished' && !book.finishedAt) book.finishedAt = today();
    db.books.push(book);
  }
  save();
  return book;
}

export function deleteBook(id) {
  db.books = db.books.filter((b) => b.id !== id);
  db.items = db.items.filter((i) => i.bookId !== id);
  save();
}

export function logSession(bookId, { date, toPage, minutes }) {
  const book = getBook(bookId);
  if (!book) return;
  const fromPage = book.currentPage || 0;
  book.sessions = book.sessions || [];
  book.sessions.push({ id: uid(), date: date || today(), fromPage, toPage, minutes: minutes || 0 });
  book.currentPage = Math.max(fromPage, toPage);
  if (book.status === 'want') { book.status = 'reading'; book.startedAt = book.startedAt || today(); }
  if (book.pages && book.currentPage >= book.pages && book.status !== 'finished') {
    book.status = 'finished';
    book.finishedAt = date || today();
  }
  save();
}

// ---------- Items (highlights, quotes, notes, words…) ----------
export const getItem = (id) => db.items.find((i) => i.id === id);
export const itemsForBook = (bookId) => db.items.filter((i) => i.bookId === bookId);

export function upsertItem(data) {
  const now = new Date().toISOString();
  let item = data.id && getItem(data.id);
  if (item) {
    Object.assign(item, data, { updatedAt: now });
  } else {
    item = {
      id: uid(), bookId: '', source: '', kind: 'highlight', text: '', note: '', context: '',
      page: '', chapter: '', tags: [], favorite: false,
      rv: { due: today(), interval: 0, seen: 0, archived: false },
      createdAt: now, updatedAt: now, ...data,
    };
    if (!data.id) item.id = uid();
    db.items.push(item);
  }
  save();
  return item;
}

export function deleteItem(id) {
  db.items = db.items.filter((i) => i.id !== id);
  save();
}

export function allTags() {
  const counts = {};
  for (const x of [...db.books, ...db.items]) for (const t of x.tags || []) counts[t] = (counts[t] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

// ---------- Daily review (lightweight spaced repetition) ----------
export function buildReviewQueue() {
  const n = db.settings.dailyReview || 5;
  const t = today();
  const pool = db.items.filter((i) => i.text && !(i.rv && i.rv.archived));
  const due = pool
    .filter((i) => !i.rv || i.rv.due <= t)
    .sort((a, b) => (b.favorite - a.favorite) || ((a.rv?.due || '').localeCompare(b.rv?.due || '')) || Math.random() - 0.5);
  let queue = due.slice(0, n);
  if (queue.length < n) {
    const rest = pool.filter((i) => !queue.includes(i)).sort(() => Math.random() - 0.5);
    queue = queue.concat(rest.slice(0, n - queue.length));
  }
  return queue.map((i) => i.id);
}

// feedback: 'again' (soon) | 'good' | 'later' (much later) | 'never'
export function reviewItem(id, feedback) {
  const item = getItem(id);
  if (!item) return;
  const rv = item.rv || { due: today(), interval: 0, seen: 0, archived: false };
  const base = Math.max(rv.interval || 0, 1);
  if (feedback === 'again') rv.interval = 2;
  else if (feedback === 'good') rv.interval = Math.round(base * 2.5 + 2);
  else if (feedback === 'later') rv.interval = Math.round(base * 6 + 14);
  else if (feedback === 'never') rv.archived = true;
  rv.interval = Math.min(rv.interval, 365);
  rv.due = addDays(today(), rv.interval);
  rv.seen = (rv.seen || 0) + 1;
  rv.lastSeen = today();
  item.rv = rv;
  db.reviewLog[today()] = (db.reviewLog[today()] || 0) + 1;
  save();
}

export function reviewStreak() {
  let streak = 0;
  let d = today();
  if (!db.reviewLog[d]) d = addDays(d, -1); // today not done yet doesn't break the streak
  while (db.reviewLog[d]) { streak++; d = addDays(d, -1); }
  return streak;
}

// ---------- Backup ----------
export function exportJSON() {
  // Your AI key stays on this device — it's never written into backups.
  const { geminiKey, ...settings } = db.settings;
  return JSON.stringify({ ...db, settings, timer: undefined }, null, 2);
}

export function importJSON(text, mode = 'merge') {
  const data = JSON.parse(text);
  if (!Array.isArray(data.books) || !Array.isArray(data.items)) throw new Error('Not a Bibliophile backup file');
  if (mode === 'replace') {
    db.books = data.books;
    db.items = data.items;
    db.settings = { ...db.settings, ...(data.settings || {}), geminiKey: db.settings.geminiKey };
    db.reviewLog = data.reviewLog || {};
  } else {
    const bIds = new Set(db.books.map((b) => b.id));
    const iIds = new Set(db.items.map((i) => i.id));
    db.books.push(...data.books.filter((b) => !bIds.has(b.id)));
    db.items.push(...data.items.filter((i) => !iIds.has(i.id)));
    for (const [k, v] of Object.entries(data.reviewLog || {})) db.reviewLog[k] = Math.max(db.reviewLog[k] || 0, v);
  }
  save();
}

// Find a book by title/author or create it — used by importers.
export function findOrCreateBook(title, author, extra = {}) {
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  let book = db.books.find((b) => norm(b.title) === norm(title) && (!author || !b.author || norm(b.author) === norm(author)));
  if (!book) {
    book = {
      id: uid(), title, author: author || '', cover: '', isbn: '', pages: 0, year: '',
      status: 'finished', rating: 0, tags: [], format: 'ebook', currentPage: 0,
      startedAt: '', finishedAt: '', review: '', sessions: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...extra,
    };
    db.books.push(book);
  }
  return book;
}
