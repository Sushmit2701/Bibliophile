// Recommendations — free, no AI, no key, computed on this device.
//
// 1. Learn your taste from your library: ratings (and half stars), what you finished vs abandoned,
//    how much you highlighted, the subjects of each book (looked up once on Open Library), favourite
//    authors, and the themes you keep writing about in reviews, notes and tags.
// 2. Find candidates on Open Library: books sharing subjects with the books you loved, other books by
//    authors you rate highly, books tagged with the themes you write about, and a few well-loved
//    books from neighbouring genres.
// 3. Score every candidate against your taste, explain why in plain words, and learn from
//    "Want to read" / "Not for me" / "Already read".
import { db, save, upsertBook } from './store.js';

const OL = 'https://openlibrary.org';
const FIELDS = 'key,title,author_name,author_key,subject,first_publish_year,number_of_pages_median,cover_i,ratings_average,ratings_count,want_to_read_count,language,isbn';
const CACHE_KEY = 'bibliophile:recs-cache';

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJSON(url, timeout = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`Open Library ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}
async function search(params, limit = 15) {
  const u = new URL(OL + '/search.json');
  Object.entries({ ...params, fields: FIELDS, limit }).forEach(([k, v]) => u.searchParams.set(k, v));
  try { return (await getJSON(u.toString())).docs || []; } catch { return []; }
}
async function pool(tasks, n, onDone) {
  const out = []; let i = 0, done = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < tasks.length) { const k = i++; out[k] = await tasks[k](); onDone?.(++done, tasks.length); }
  }));
  return out;
}
const norm = (s) => (s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').split(':')[0].replace(/[^a-z0-9]+/g, ' ').trim();
const STOP = new Set(('the a an and or but of to in on at for with without from by about into over after before as is was were are be been being it its this that these those i me my we our you your he she him her his they them their what which who whom whose why how when where there here than then so such very really just also too much many more most less least some any all each every both either neither not no nor only own same other others another again still even ever never always often sometimes quite rather enough almost already yet once twice can could should would will shall may might must do does did done doing have has had having get got make made making go goes went going come came take took see saw seen say said know knew think thought feel felt want wanted like liked love loved one two three first last new old good great bad well better best way thing things lot lots bit kind sort part time times day days year years book books read reading reread author authors writer writing written write story stories novel novels chapter chapters page pages character characters plot end ending beginning start middle people person life world man men woman women felt feels makes made because though although while since until unless whether something anything nothing everything someone anyone everyone really actually basically literally probably definitely maybe perhaps').split(' '));
const stem = (w) => w.replace(/(ies)$/, 'y').replace(/(ness|ment|ing|edly|ed|ly|es|s)$/, '').replace(/(.)\1$/, '$1');

// ---------- subjects ----------
const GENERIC = /^(fiction|literary|literary fiction|general fiction|romans?,? ?(nouvelles)?|nouvelles|social life and custom|manners and customs|fiction, general|history|humanities|literature|general|novel|novels|large type books|large print books|accessible book|protected daisy|in library|lending library|open library staff picks|new york times (bestseller|reviewed)|reading level.*|fiction in english|english fiction|american fiction|british fiction|canadian fiction|english literature|american literature|translations into .*|amerikanisches englisch|roman|romans|ficción|ficcion|nouvelles|long now manual for civilization|popular print disabled books|overdrive|history and criticism|criticism and interpretation|readers|textbooks|juvenile literature|fiction general)$/;
function cleanSubject(raw) {
  let s = String(raw || '').trim();
  if (!s || /[=:]|^collection/i.test(s)) return null;                   // nyt:…=date, collection:…
  if (s.includes('/')) s = s.split('/').pop();                           // "FICTION / Science Fiction / Adventure"
  s = s.toLowerCase().replace(/\s*\(fiction\)/g, '').replace(/,\s*general$/, '').replace(/\s+/g, ' ').trim();
  // "Fiction, psychological" → "psychological fiction"; "Actors, fiction" → "actors"
  const m = s.match(/^fiction,\s*(.+)$/);
  if (m) s = /fiction/.test(m[1]) ? m[1] : `${m[1]} fiction`;
  s = s.replace(/,\s*fiction$/, '').replace(/^fiction\s+-+\s*/, '').trim();
  if (!s || s.length < 3 || s.length > 48 || GENERIC.test(s)) return null;
  return s;
}
const subjKey = (s) => s.split(' ').map((w) => stem(w)).join(' ');
function subjectsOf(doc) {
  const seen = new Map();
  for (const raw of doc.subject || []) {
    const s = cleanSubject(raw);
    if (!s) continue;
    const k = subjKey(s);
    if (!seen.has(k)) seen.set(k, s);
    if (seen.size >= 40) break;
  }
  return seen; // key -> display
}
const JUVENILE = /juvenile|picture book|children's|childrens|board book|young adult|young-adult|teen fiction|teenagers|novela juvenil/i;
const isJuvenile = (keys) => [...keys].some((k) => JUVENILE.test(k));
const isJuvenileRaw = (subjects) => (subjects || []).some((s) => JUVENILE.test(s));   // checks *all* tags, incl. bestseller-list ones
const isFictionDoc = (keys) => [...keys].some((k) => /fiction|novel|fantas|science fict|romance|myster|thriller|dystop|horror/.test(k)) && ![...keys].some((k) => /nonfiction|non fiction|biograph|memoir|histor(y|ical) (?!fict)/.test(k));
const looksLikeVolume = (t) => /\b(vol(ume)?\.?\s*\d+|book\s+\d+|#\d+|part\s+\d+|omnibus|box(ed)? set|collection|adaptation|abridged|graphic novel|study guide|sparknotes|cliffsnotes|summary|workbook|coloring)\b/i.test(t);

// ---------- learning about your own books ----------
async function enrich(book) {
  if (book.ol?.at && Date.now() - book.ol.at < 60 * 864e5) return;
  const isbn = (book.isbn || '').replace(/[^0-9X]/gi, '');
  let docs = isbn ? await search({ q: `isbn:${isbn}` }, 1) : [];
  if (!docs.length && book.title) docs = await search({ title: book.title.split(':')[0], ...(book.author ? { author: book.author.split(/[,&]| and /)[0] } : {}) }, 3);
  const d = docs.find((x) => norm(x.title) === norm(book.title)) || docs[0];
  book.ol = d
    ? { at: Date.now(), key: d.key, subjects: (d.subject || []).slice(0, 60), authorKeys: (d.author_key || []).slice(0, 3), pages: d.number_of_pages_median || 0 }
    : { at: Date.now(), key: '', subjects: [], authorKeys: [] };
}

function bookWeight(b, nItems) {
  let w;
  if (b.status === 'abandoned') w = -1.5;
  else if (b.rating) w = (b.rating - 3) * 1.1;              // 5★ +2.2 · 4★ +1.1 · 3★ 0 · 2★ −1.1
  else if (b.status === 'finished' || b.status === 'reading') w = 0.6;
  else if (b.status === 'want') w = 0.3;
  else w = 0.1;
  if (w > 0) w += Math.min(0.8, nItems * 0.08);               // lots of highlights = it really landed
  return w;
}

function themeTerms(itemsByBook) {
  const counts = new Map();
  const add = (text, weight) => {
    for (const raw of String(text || '').toLowerCase().match(/[a-z][a-z'-]{3,}/g) || []) {
      const w = raw.replace(/'s$/, '');
      if (STOP.has(w) || w.length < 4) continue;
      const k = stem(w);
      const e = counts.get(k) || { k, word: w, w: 0, n: 0 };
      e.w += weight; e.n++; if (w.length < e.word.length) e.word = w;
      counts.set(k, e);
    }
  };
  for (const b of db.books) {
    const items = itemsByBook.get(b.id) || [];
    const bw = b.rating ? b.rating - 2.5 : b.status === 'abandoned' ? 0 : 1; // your words about books you liked count most
    if (bw <= 0) continue;
    add(b.review, bw);
    for (const t of b.tags || []) add(t, bw * 2);
    for (const i of items) {
      add(i.note, bw);
      for (const t of i.tags || []) add(t, bw * 1.5);
      if (i.favorite && i.kind !== 'word') add(i.text, bw * 0.3);
    }
  }
  return [...counts.values()].filter((e) => e.n >= 2 || e.w >= 3).sort((a, b) => b.w - a.w).slice(0, 14);
}

export function buildProfile() {
  const itemsByBook = new Map();
  for (const i of db.items) { if (!itemsByBook.has(i.bookId)) itemsByBook.set(i.bookId, []); itemsByBook.get(i.bookId).push(i); }
  const subj = new Map(); const label = new Map(); const authors = new Map();
  // Only steer away from children's / young-adult books if you don't read them yourself.
  const juvenileInLibrary = db.books.filter((b) => (b.rating || 0) >= 3.5 && isJuvenileRaw(b.ol?.subjects)).length >= 2;
  for (const b of db.books) {
    const w = bookWeight(b, (itemsByBook.get(b.id) || []).length);
    const s = subjectsOf({ subject: b.ol?.subjects });
    const scale = 2 / Math.sqrt(Math.max(6, s.size));
    for (const [k, d] of s) { subj.set(k, (subj.get(k) || 0) + w * scale); label.set(k, d); }
    for (const ak of b.ol?.authorKeys || []) {
      const a = authors.get(ak) || { key: ak, name: b.author, sum: 0, n: 0, rated: 0 };
      a.sum += b.rating || (b.status === 'finished' ? 3.5 : 0); a.n++; if (b.rating) a.rated++;
      authors.set(ak, a);
    }
  }
  // Learn from "Not for me".
  const rec = db.recs || {};
  for (const d of Object.values(rec.dismissed || {})) {
    const hit = d.reason === 'genre' ? -0.8 : d.reason === 'similar' ? -0.35 : 0;
    if (hit) for (const k of d.subjects || []) subj.set(k, (subj.get(k) || 0) + hit);
  }
  const lovedAuthors = [...authors.values()].filter((a) => a.n && a.sum / a.n >= 4).sort((a, b) => b.sum / b.n - a.sum / a.n || b.n - a.n);
  const anchors = db.books
    .filter((b) => b.ol?.subjects?.length && (b.rating >= 4 || (!b.rating && b.status === 'finished' && (itemsByBook.get(b.id) || []).length >= 3)))
    .sort((a, b) => (b.rating || 4) - (a.rating || 4) || (b.finishedAt || b.updatedAt || '').localeCompare(a.finishedAt || a.updatedAt || ''))
    .slice(0, 3);
  const top = [...subj.entries()].filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1]);
  return {
    subj, label, top, anchors, lovedAuthors, juvenileOK: juvenileInLibrary,
    themes: themeTerms(itemsByBook),
    maxPages: rec.maxPages || 0,
    owned: new Set(db.books.flatMap((b) => [b.ol?.key, 't:' + norm(b.title)]).filter(Boolean)),
    dismissed: new Set(Object.keys(rec.dismissed || {})),
    rated: db.books.filter((b) => b.rating || b.status === 'finished').length,
  };
}

// ---------- scoring ----------
function score(c, prof) {
  const keys = [...c.subj.keys()];
  let s = 0; const matched = [];
  for (const k of keys) { const w = prof.subj.get(k) || 0; s += w; if (w > 0.15) matched.push([k, w]); }
  s /= Math.sqrt(Math.max(8, keys.length));
  const text = keys.join(' | ') + ' | ' + norm(c.title);
  const themes = prof.themes.filter((t) => text.includes(t.k));
  const th = Math.min(3, themes.reduce((a, t) => a + Math.min(1.5, t.w / 3), 0));
  const pop = Math.log10(1 + (c.want || 0)) * 0.22 + (c.avg ? (c.avg - 3.7) * Math.min(1, (c.rc || 0) / 25) * 1.2 : 0);
  let pen = 0;
  if (looksLikeVolume(c.title)) pen -= 1;
  if (!prof.juvenileOK && (c.juvenile || isJuvenile(c.subj.keys()))) pen -= 4;
  if (prof.maxPages && c.pages > prof.maxPages) pen -= 1.2;
  const readers = (c.rc || 0) * 3 + (c.want || 0);
  if (readers < 15) pen -= 1.6;                            // almost nobody on Open Library has read it — likely noise
  else if (readers < 60) pen -= 0.6;
  return { total: s * 3 + th * 0.9 + pop + pen, sim: s, matched: matched.sort((a, b) => b[1] - a[1]), themes };
}

function toCandidate(d) {
  return {
    key: d.key, title: d.title, authors: (d.author_name || []).slice(0, 1), authorKeys: d.author_key || [],
    year: d.first_publish_year || '', pages: d.number_of_pages_median || 0, cover: d.cover_i || 0,
    avg: d.ratings_average || 0, rc: d.ratings_count || 0, want: d.want_to_read_count || 0,
    isbn: (d.isbn || []).find((x) => x.length === 13) || (d.isbn || [])[0] || '',
    // ISBNs starting 978-0 / 978-1 (or 0 / 1) are English-language editions — prefer their covers.
    enIsbn: (d.isbn || []).find((x) => /^97[89][01]\d{9}$/.test(x)) || (d.isbn || []).find((x) => /^[01]\d{8}[\dX]$/i.test(x)) || '',
    subj: subjectsOf(d), lang: d.language || [], juvenile: isJuvenileRaw(d.subject),
  };
}

// ---------- building the page ----------
export function cached() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch { return null; }
}
export function librarySignature() {
  const r = db.recs || {};
  return [db.books.map((b) => `${b.id}:${b.rating}:${b.status}:${(b.review || '').length}`).join(','), Object.keys(r.dismissed || {}).length, db.items.length].join('|');
}
export const isStale = (c) => !c || c.sig !== librarySignature() || Date.now() - c.at > 24 * 3600e3;

export async function buildRecommendations(onProgress = () => {}) {
  // 1. learn subjects of your own books (once per book)
  const todo = db.books.filter((b) => !(b.ol?.at && Date.now() - b.ol.at < 60 * 864e5));
  if (todo.length) {
    await pool(todo.map((b) => () => enrich(b)), 3, (i, n) => onProgress(`Learning your taste… ${i} of ${n} books`));
    save({ quiet: true });
  }
  const prof = buildProfile();
  if (!prof.top.length && !prof.lovedAuthors.length) return finish({ sections: [], reason: 'empty', prof });

  // 2. gather candidates
  const queries = []; // { tag, params }
  const quote = (s) => `"${s.replace(/"/g, '')}"`;
  const genreOf = (keys) => keys.find((k) => /fiction|fantas|myster|thriller|romance|dystop|horror|histor|biograph|memoir|philosoph|psycholog|science|poetry|essay/.test(k));
  for (const a of prof.anchors) {
    const s = [...subjectsOf({ subject: a.ol.subjects }).keys()];
    const g = genreOf(s) || prof.top[0]?.[0];
    const specific = s.filter((k) => k !== g).slice(0, 4);
    for (const sp of specific) queries.push({ tag: 'anchor:' + a.id, params: { q: `subject:${quote(prof.label.get(g) || g)} subject:${quote(prof.label.get(sp) || sp)}`, sort: 'readinglog' } });
  }
  const topKeys = prof.top.slice(0, 6).map(([k]) => k);
  [[0, 1], [0, 2], [1, 2], [3, 4], [2, 5]].forEach(([i, j]) => {
    if (topKeys[i] && topKeys[j]) queries.push({ tag: 'taste', params: { q: `subject:${quote(prof.label.get(topKeys[i]))} subject:${quote(prof.label.get(topKeys[j]))}`, sort: 'readinglog' } });
  });
  for (const a of prof.lovedAuthors.slice(0, 3)) queries.push({ tag: 'author:' + a.key, params: { q: `author_key:${a.key}`, sort: 'readinglog' } });
  const g0 = prof.label.get(genreOf(prof.top.slice(0, 12).map(([k]) => k)) || topKeys[0]);
  for (const t of prof.themes.slice(0, 4)) queries.push({ tag: 'theme:' + t.k, params: { q: `subject:${quote(t.word)}${g0 ? ` subject:${quote(g0)}` : ''}`, sort: 'readinglog' } });

  const found = new Map(); // key -> candidate (+ where it came from)
  const results = await pool(queries.map((q) => () => search(q.params, 15)), 4, (i, n) => onProgress(`Finding books… ${i} of ${n} searches`));
  results.forEach((docs, qi) => {
    for (const d of docs || []) {
      if (!d.key || !d.title) continue;
      const c = found.get(d.key) || toCandidate(d);
      (c.from ||= new Set()).add(queries[qi].tag);
      found.set(d.key, c);
    }
  });

  // a few well-loved books from neighbouring subjects ("something different")
  const neighbour = new Map();
  const goodOnes = [...found.values()].map((c) => [c, score(c, prof).total]).filter(([, t]) => t > 0.5);
  for (const [c, t] of goodOnes) for (const k of c.subj.keys()) if (!prof.subj.has(k)) neighbour.set(k, (neighbour.get(k) || 0) + t);
  const adj = [...neighbour.entries()]
    .filter(([k]) => !/juvenile|children|picture|young adult|teen|translations|comic|graphic|english|american|british|language|prize|bestseller|award|reviewed|staff|accessible|large|readers|study|guide|criticism|history and|general|\d/.test(k) && k.split(' ').length <= 3)
    .sort((a, b) => b[1] - a[1]).slice(0, 3);
  const adjRes = await pool(adj.map(([k]) => () => search({ q: `subject:${quote(k)}`, sort: 'readinglog' }, 12)), 3);
  adjRes.forEach((docs, i) => (docs || []).forEach((d) => {
    if (!d.key || found.has(d.key)) return;
    const c = toCandidate(d); c.from = new Set(['different:' + adj[i][0]]); found.set(d.key, c);
  }));

  // 3. filter + score
  const latin = (t) => !/[^\u0000-\u024F\u2000-\u206F’‘“”–—]/.test(t);        // skip titles shown only in another script
  const fresh = [...found.values()].filter((c) => latin(c.title) && latin(c.authors[0] || '') && norm(c.title) !== norm(c.authors[0]) && !prof.owned.has(c.key) && !prof.owned.has('t:' + norm(c.title)) && !prof.dismissed.has(c.key)
    && !(c.lang.length && !c.lang.includes('eng'))
    && !(c.juvenile && !prof.juvenileOK));                 // no children's / young-adult books unless you read them
  const seenTitle = new Set();
  const scored = fresh.map((c) => ({ c, s: score(c, prof) })).sort((a, b) => b.s.total - a.s.total)
    .filter(({ c }) => { const t = norm(c.title); if (seenTitle.has(t)) return false; seenTitle.add(t); return true; });

  // 4. sections
  const used = new Set();
  const known = (c) => (c.rc || 0) * 3 + (c.want || 0) >= 15;   // at least a few readers on Open Library
  const take = (list, n, perAuthor = 2, allowObscure = false) => {
    const out = []; const byAuthor = new Map();
    for (const x of list) {
      if (out.length >= n) break;
      if (used.has(x.c.key) || x.s.total < -0.5 || (!allowObscure && !known(x.c))) continue;
      const a = x.c.authorKeys[0] || x.c.authors[0];
      if ((byAuthor.get(a) || 0) >= perAuthor) continue;
      byAuthor.set(a, (byAuthor.get(a) || 0) + 1); used.add(x.c.key); out.push(x);
    }
    return out;
  };
  const sections = [];
  for (const a of prof.anchors) {
    const aKeys = new Set(subjectsOf({ subject: a.ol.subjects }).keys());
    const list = scored.filter((x) => x.c.from.has('anchor:' + a.id))
      .map((x) => ({ ...x, shared: [...x.c.subj.keys()].filter((k) => aKeys.has(k)) }))
      .sort((p, q) => (Math.min(4, q.shared.length) * 0.4 + q.s.total) - (Math.min(4, p.shared.length) * 0.4 + p.s.total));
    const picks = take(list, 6);
    if (picks.length) sections.push({ id: 'anchor-' + a.id, title: `Because you loved ${a.title}`, kind: 'anchor', anchor: a.title, items: picks.map((x) => card(x, prof, { anchor: a, shared: x.shared })) });
  }
  if (prof.themes.length) {
    const list = scored.filter((x) => x.s.themes.length).sort((p, q) => (q.s.themes.length + q.s.total * 0.5) - (p.s.themes.length + p.s.total * 0.5));
    const picks = take(list, 6);
    if (picks.length) sections.push({ id: 'themes', title: 'Matches what you write about', kind: 'themes', items: picks.map((x) => card(x, prof, { themes: true })) });
  }
  const authorList = scored.filter((x) => [...x.c.from].some((t) => t.startsWith('author:')));
  const ap = take(authorList, 6, 2, true);   // lesser-known books by authors you love are still worth showing
  if (ap.length) sections.push({ id: 'authors', title: 'From authors you rate highly', kind: 'authors', items: ap.map((x) => card(x, prof, { author: true })) });
  const best = take(scored.filter((x) => x.s.sim > 0), 8);
  if (best.length) sections.unshift({ id: 'top', title: 'Top picks for you', kind: 'top', items: best.map((x) => card(x, prof, {})) });
  const diff = take(scored.filter((x) => [...x.c.from].some((t) => t.startsWith('different:')) && x.c.avg >= 3.9 && x.c.rc >= 10).sort((p, q) => q.s.total - p.s.total), 4, 1);
  if (diff.length) sections.push({ id: 'different', title: 'Something different', kind: 'different', items: diff.map((x) => card(x, prof, { different: [...x.c.from].find((t) => t.startsWith('different:')).slice(10) })) });

  return finish({ sections, prof });
}

function finish({ sections, reason = '', prof }) {
  const data = { at: Date.now(), sig: librarySignature(), sections, reason, ratedCount: prof?.rated || 0 };
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch {}
  return data;
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const fmtK = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k' : String(n));
function card(x, prof, why) {
  const { c, s } = x;
  const nice = (k) => prof.label.get(k) || c.subj.get(k) || k;
  const list3 = (keys) => { const out = []; for (const k of keys) { const t = nice(k).replace(/\s*--.*$/, ''); if (!out.some((o) => o.includes(t) || t.includes(o))) out.push(t); if (out.length === 3) break; } return out.join(', '); };
  let reason;
  if (why.anchor) reason = why.shared?.length ? `Like ${why.anchor.title}: ${list3(why.shared)}` : `Readers of ${why.anchor.title} also shelve this`;
  else if (why.themes) reason = `Themes you write about: ${s.themes.slice(0, 3).map((t) => t.word).join(', ')}`;
  else if (why.author) {
    const a = prof.lovedAuthors.find((l) => c.authorKeys.includes(l.key));
    reason = a ? `You rate ${a.name || c.authors[0]} ${(a.sum / a.n).toFixed(1).replace(/\.0$/, '')}★ on average` : `By an author you like`;
  } else if (why.different) reason = `A step outside your usual: much-loved in ${why.different}`;
  else reason = s.matched.length ? `Fits what you love: ${list3(s.matched.map(([k]) => k))}` : 'Popular with readers of books like yours';
  const readers = [c.avg && c.rc >= 3 ? `★ ${c.avg.toFixed(1)} from ${fmtK(c.rc)} readers` : '', c.want >= 20 ? `${fmtK(c.want)} want to read it` : ''].filter(Boolean).join(' · ');
  const fiction = isFictionDoc(c.subj.keys());
  return {
    key: c.key, title: c.title, author: c.authors.join(' & '), year: c.year, pages: c.pages, cover: c.cover, isbn: c.enIsbn || c.isbn, enIsbn: c.enIsbn,
    reason, readers, fiction, authorKeys: c.authorKeys.slice(0, 3),
    subjects: [...c.subj.keys()].slice(0, 8), tags: [...c.subj.values()].slice(0, 6),
  };
}

// ---------- details + feedback ----------
const descCache = new Map();
export const describedAlready = (key) => descCache.get(key);
export async function describe(key) {
  if (descCache.has(key)) return descCache.get(key);
  let text = '';
  try {
    const w = await getJSON(`${OL}${key}.json`, 10000);
    const d = w.description;
    text = (typeof d === 'string' ? d : d?.value || '').replace(/\r/g, '').split(/\n-{3,}|\n\s*\(?source:|\[source\]/i)[0].trim();
  } catch {}
  descCache.set(key, text);
  return text;
}

const recs = () => (db.recs ||= { dismissed: {}, wanted: {} });

export function dismiss(cardData, reason) {
  const r = recs();
  r.dismissed[cardData.key] = { at: Date.now(), reason, subjects: cardData.subjects.slice(0, 6), title: cardData.title };
  if (reason === 'long' && cardData.pages) r.maxPages = Math.min(r.maxPages || Infinity, Math.max(150, Math.round(cardData.pages * 0.85)));
  save({ quiet: true });
}
export function undismiss(key) { delete recs().dismissed[key]; save({ quiet: true }); }

export function addToLibrary(cardData, status) {
  const book = upsertBook({
    title: cardData.title, author: cardData.author, status, pages: cardData.pages || 0, year: String(cardData.year || ''),
    isbn: cardData.isbn || '',
    cover: cardData.enIsbn ? `https://covers.openlibrary.org/b/isbn/${cardData.enIsbn}-L.jpg?default=false` : cardData.cover ? `https://covers.openlibrary.org/b/id/${cardData.cover}-L.jpg` : '',
    format: 'print', tags: [],
    ol: { at: Date.now(), key: cardData.key, subjects: cardData.tags.concat(cardData.subjects), authorKeys: cardData.authorKeys || [] },
  });
  recs().wanted[cardData.key] = Date.now();
  save({ quiet: true });
  return book;
}
