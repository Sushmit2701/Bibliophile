// Importers for Kindle "My Clippings.txt", Readwise CSV exports and Goodreads CSV exports.
import { db, uid, today, save, findOrCreateBook } from './store.js';

function newItem(bookId, fields) {
  const now = new Date().toISOString();
  return {
    id: uid(), bookId, source: '', kind: 'highlight', text: '', note: '', page: '', chapter: '',
    tags: [], favorite: false, rv: { due: today(), interval: 0, seen: 0, archived: false },
    createdAt: now, updatedAt: now, ...fields,
  };
}

const exists = (bookId, text) => db.items.some((i) => i.bookId === bookId && i.text.trim() === text.trim());

// ---------- Kindle ----------
export function importKindle(text) {
  const entries = text.replace(/\r/g, '').replace(/^﻿/, '').split(/^==========\s*$/m);
  let added = 0, skipped = 0;
  const pendingNotes = [];
  for (const raw of entries) {
    const lines = raw.split('\n').map((l) => l.trim());
    while (lines.length && !lines[0]) lines.shift();
    if (lines.length < 3) continue;
    const head = lines[0].replace(/^﻿/, '');
    const meta = lines[1];
    const body = lines.slice(2).join('\n').trim();
    if (!body || /bookmark/i.test(meta)) continue;

    let title = head, author = '';
    const m = head.match(/^(.*)\(([^()]*)\)\s*$/);
    if (m) { title = m[1].trim(); author = m[2].trim(); }
    if (author.includes(',')) { const [last, first] = author.split(',').map((s) => s.trim()); if (first && author.split(',').length === 2) author = `${first} ${last}`; }

    const page = (meta.match(/page\s+([\w-]+)/i) || [])[1] || '';
    const loc = (meta.match(/location\s+([\d-]+)/i) || [])[1] || '';
    const added_ = (meta.match(/Added on (.*)$/i) || [])[1];
    const date = added_ && !isNaN(Date.parse(added_)) ? new Date(added_).toISOString() : new Date().toISOString();

    const book = findOrCreateBook(title, author);
    if (/note/i.test(meta) && !/highlight/i.test(meta)) {
      pendingNotes.push({ book, loc, body, date });
      continue;
    }
    if (exists(book.id, body)) { skipped++; continue; }
    db.items.push(newItem(book.id, { text: body, page: page || (loc ? `loc ${loc}` : ''), createdAt: date, _loc: loc }));
    added++;
  }
  // Attach Kindle notes to the highlight at the same location when possible
  for (const n of pendingNotes) {
    const end = n.loc.split('-')[0];
    const target = db.items.find((i) => i.bookId === n.book.id && i._loc && i._loc.split('-').includes(end));
    if (target) { if (!target.note.includes(n.body)) target.note = target.note ? `${target.note}\n${n.body}` : n.body; }
    else if (!exists(n.book.id, n.body)) { db.items.push(newItem(n.book.id, { kind: 'note', text: n.body, page: n.loc ? `loc ${n.loc}` : '', createdAt: n.date })); added++; }
  }
  db.items.forEach((i) => delete i._loc);
  save();
  return { added, skipped };
}

// ---------- CSV ----------
export function parseCSV(text) {
  const rows = [];
  let row = [], field = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const header = (rows.shift() || []).map((h) => h.trim());
  return rows.filter((r) => r.some((x) => x.trim())).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

// Readwise export: Highlight, Book Title, Book Author, Note, Tags, Location, Highlighted at …
export function importReadwise(text) {
  const rows = parseCSV(text);
  if (!rows.length || !('Highlight' in rows[0])) throw new Error('This does not look like a Readwise CSV export.');
  let added = 0, skipped = 0;
  for (const r of rows) {
    const body = (r['Highlight'] || '').trim();
    if (!body) continue;
    const book = findOrCreateBook(r['Book Title'] || 'Untitled', r['Book Author'] || '');
    if (exists(book.id, body)) { skipped++; continue; }
    const tags = (r['Tags'] || '').split(/[,;]/).map((t) => t.trim().toLowerCase()).filter(Boolean);
    const loc = r['Location'] ? `${r['Location Type'] === 'page' ? '' : (r['Location Type'] || 'loc') + ' '}${r['Location']}`.trim() : '';
    const when = r['Highlighted at'] && !isNaN(Date.parse(r['Highlighted at'])) ? new Date(r['Highlighted at']).toISOString() : new Date().toISOString();
    db.items.push(newItem(book.id, { text: body, note: r['Note'] || '', tags, page: loc, createdAt: when, favorite: tags.includes('favorite') }));
    added++;
  }
  save();
  return { added, skipped };
}

// Goodreads export: Title, Author, My Rating, Exclusive Shelf, Date Read, Date Added, Number of Pages, ISBN13, My Review, Bookshelves
export function importGoodreads(text) {
  const rows = parseCSV(text);
  if (!rows.length || !('Exclusive Shelf' in rows[0])) throw new Error('This does not look like a Goodreads CSV export.');
  const shelfMap = { read: 'finished', 'currently-reading': 'reading', 'to-read': 'want' };
  const dateFix = (s) => (s ? s.replace(/\//g, '-') : '');
  let added = 0, updated = 0;
  for (const r of rows) {
    const title = (r['Title'] || '').trim();
    if (!title) continue;
    const before = db.books.length;
    const isbn = (r['ISBN13'] || r['ISBN'] || '').replace(/[^0-9X]/gi, '');
    const book = findOrCreateBook(title, r['Author'] || '', { format: 'print' });
    const isNew = db.books.length > before;
    Object.assign(book, {
      status: shelfMap[r['Exclusive Shelf']] || book.status || 'want',
      rating: Number(r['My Rating']) || book.rating || 0,
      pages: Number(r['Number of Pages']) || book.pages || 0,
      isbn: isbn || book.isbn,
      year: r['Original Publication Year'] || r['Year Published'] || book.year,
      finishedAt: dateFix(r['Date Read']) || book.finishedAt,
      review: book.review || (r['My Review'] || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''),
      tags: [...new Set([...(book.tags || []), ...(r['Bookshelves'] || '').split(',').map((s) => s.trim()).filter((s) => s && !shelfMap[s])])],
    });
    if (!book.cover && isbn) book.cover = `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg?default=false`;
    if (book.status === 'finished' && book.pages) book.currentPage = book.pages;
    isNew ? added++ : updated++;
  }
  save();
  return { added, updated };
}
