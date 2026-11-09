// "My year in books" — a 1080×1920 story-sized image built from your reading log.
import { db, itemsForBook, fmtRating } from './store.js';

const THEMES = {
  ivory: { bg: '#f6f1e7', fg: '#1d1a17', soft: '#4a433c', muted: '#8b8176', accent: '#6e1f24', gold: '#a8843f', rule: '#d9cdb8' },
  night: { bg: '#0e1311', fg: '#ebe4d6', soft: '#c8c0b1', muted: '#8d978f', accent: '#c6a15b', gold: '#c6a15b', rule: '#2c3833' },
  oxblood: { bg: '#3d1013', fg: '#f3e6d3', soft: '#e3cfb5', muted: '#b9988a', accent: '#d8b46a', gold: '#d8b46a', rule: '#5e2427' },
};
export const YEAR_THEMES = Object.keys(THEMES);
const CLOTH = ['#5a1a1f', '#1f3a2f', '#1d2a44', '#3f2440', '#5b3b1c', '#2c3b40', '#6b2a1a', '#22262e'];
const DISPLAY = "'Cormorant Garamond', Georgia, serif";
const SERIF = "'EB Garamond', Georgia, serif";
const SANS = "Inter, system-ui, sans-serif";

export function yearStats(year) {
  const y = String(year);
  const finished = db.books.filter((b) => b.status === 'finished' && (b.finishedAt || '').startsWith(y))
    .sort((a, b) => (a.finishedAt || '').localeCompare(b.finishedAt || ''));
  let minutes = 0, pagesLogged = 0;
  for (const b of db.books) for (const s of b.sessions || []) {
    if (!s.date.startsWith(y)) continue;
    minutes += s.minutes || 0;
    pagesLogged += Math.max(0, s.toPage - s.fromPage);
  }
  const pages = Math.max(pagesLogged, finished.reduce((t, b) => t + (Number(b.pages) || 0), 0));
  const items = db.items.filter((i) => (i.createdAt || '').startsWith(y));
  const rated = finished.filter((b) => b.rating);
  const best = rated.slice().sort((a, b) => b.rating - a.rating || itemsForBook(b.id).length - itemsForBook(a.id).length)[0];
  const quotes = items.filter((i) => i.kind !== 'word' && i.text && i.text.length < 260);
  const line = quotes.sort((a, b) => (b.favorite - a.favorite) || (a.text.length - b.text.length))[0];
  const authors = {};
  for (const b of finished) if (b.author) authors[b.author] = (authors[b.author] || 0) + 1;
  const topAuthor = Object.entries(authors).sort((a, b) => b[1] - a[1])[0];
  const byMonth = Array(12).fill(0);
  for (const b of finished) { const m = Number((b.finishedAt || '').slice(5, 7)); if (m) byMonth[m - 1]++; }
  return { year: y, finished, pages, minutes, items, best, line, topAuthor: topAuthor && topAuthor[1] > 1 ? topAuthor : null, byMonth,
    avg: rated.length ? rated.reduce((t, b) => t + b.rating, 0) / rated.length : 0 };
}

function wrap(ctx, text, maxWidth, maxLines = 99) {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = w; } else line = test;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '') + '…'; }
  return lines;
}

function spaced(ctx, text, x, y, spacing, align = 'center') {
  const chars = [...text];
  const width = chars.reduce((w, c) => w + ctx.measureText(c).width + spacing, -spacing);
  let cx = align === 'center' ? x - width / 2 : align === 'right' ? x - width : x;
  for (const c of chars) { ctx.fillText(c, cx, y); cx += ctx.measureText(c).width + spacing; }
}

function loadImage(src) {
  return new Promise((res) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const timer = setTimeout(() => res(null), 4000);
    img.onload = () => { clearTimeout(timer); res(img.naturalWidth > 2 ? img : null); };
    img.onerror = () => { clearTimeout(timer); res(null); };
    img.src = src;
  });
}

function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }

function drawCloth(ctx, book, x, y, w, h) {
  ctx.fillStyle = CLOTH[hash(book.title || '?') % CLOTH.length];
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(231,207,152,.5)'; ctx.lineWidth = 1.5;
  const inset = w * 0.08;
  ctx.strokeRect(x + inset, y + inset, w - inset * 2, h - inset * 2);
  ctx.fillStyle = '#e7cf98'; ctx.textAlign = 'center';
  const size = Math.max(14, Math.round(w / 7));
  ctx.font = `500 ${size}px ${DISPLAY}`;
  const lines = wrap(ctx, book.title, w - inset * 3, 4);
  const top = y + h / 2 - (lines.length * size * 1.15) / 2 + size * 0.8;
  lines.forEach((l, i) => ctx.fillText(l, x + w / 2, top + i * size * 1.15));
}

async function drawCovers(ctx, books, x, y, width, t, useImages) {
  if (!books.length) return y;
  const n = books.length;
  const cols = n <= 4 ? n : n <= 8 ? 4 : n <= 15 ? 5 : 6;
  const shown = books.slice(0, cols * 3);
  const gap = 22;
  const w = Math.min(n > 4 ? 165 : 190, (width - gap * (cols - 1)) / cols);
  const h = w * 1.5;
  const rowW = Math.min(shown.length, cols) * w + (Math.min(shown.length, cols) - 1) * gap;
  const imgs = useImages ? await Promise.all(shown.map((b) => (b.cover ? loadImage(b.cover) : null))) : shown.map(() => null);
  shown.forEach((b, i) => {
    const r = Math.floor(i / cols), c = i % cols;
    const inRow = Math.min(cols, shown.length - r * cols);
    const rw = inRow * w + (inRow - 1) * gap;
    const cx = x + (width - rw) / 2 + c * (w + gap);
    const cy = y + r * (h + gap);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 24; ctx.shadowOffsetY = 12;
    ctx.fillStyle = '#000'; ctx.fillRect(cx, cy, w, h);
    ctx.restore();
    if (imgs[i]) ctx.drawImage(imgs[i], cx, cy, w, h); else drawCloth(ctx, b, cx, cy, w, h);
    const g = ctx.createLinearGradient(cx, 0, cx + w, 0);
    g.addColorStop(0, 'rgba(0,0,0,.3)'); g.addColorStop(0.03, 'rgba(255,255,255,.14)'); g.addColorStop(0.08, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(cx, cy, w, h);
  });
  const rows = Math.ceil(shown.length / cols);
  let end = y + rows * h + (rows - 1) * gap;
  if (books.length > shown.length) {
    ctx.fillStyle = t.muted; ctx.font = `italic 30px ${SERIF}`; ctx.textAlign = 'center';
    ctx.fillText(`and ${books.length - shown.length} more`, x + width / 2, end + 50);
    end += 50;
  }
  return end;
}

async function paint(year, themeName, useImages) {
  const t = THEMES[themeName] || THEMES.ivory;
  const s = yearStats(year);
  const W = 1080, H = 1920, P = 90;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = t.bg; ctx.fillRect(0, 0, W, H);
  // frame
  ctx.strokeStyle = t.rule; ctx.lineWidth = 2; ctx.strokeRect(40, 40, W - 80, H - 80);
  ctx.lineWidth = 1; ctx.strokeRect(52, 52, W - 104, H - 104);

  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = t.gold; ctx.font = `36px ${DISPLAY}`; ctx.fillText('❦', W / 2, 150);
  ctx.font = `600 22px ${SANS}`; spaced(ctx, 'MY YEAR IN BOOKS', W / 2, 205, 7);
  ctx.fillStyle = t.fg; ctx.font = `500 200px ${DISPLAY}`; ctx.fillText(s.year, W / 2, 400);

  // figures
  const hours = Math.round(s.minutes / 60);
  const figs = [[s.finished.length, s.finished.length === 1 ? 'book' : 'books'], [s.pages.toLocaleString(), 'pages'],
    hours ? [hours, hours === 1 ? 'hour' : 'hours'] : [s.items.length, 'passages kept']];
  const colW = (W - P * 2) / 3;
  let y = 470;
  ctx.strokeStyle = t.rule; ctx.beginPath(); ctx.moveTo(P, y); ctx.lineTo(W - P, y); ctx.stroke();
  figs.forEach(([n, label], i) => {
    const cx = P + colW * i + colW / 2;
    if (i) { ctx.beginPath(); ctx.moveTo(P + colW * i, y + 25); ctx.lineTo(P + colW * i, y + 165); ctx.stroke(); }
    ctx.fillStyle = t.fg; ctx.font = `500 84px ${DISPLAY}`; ctx.fillText(String(n), cx, y + 108);
    ctx.fillStyle = t.muted; ctx.font = `600 19px ${SANS}`; spaced(ctx, label.toUpperCase(), cx, y + 150, 4);
  });
  y += 190;
  ctx.beginPath(); ctx.moveTo(P, y); ctx.lineTo(W - P, y); ctx.stroke();

  // covers
  y = await drawCovers(ctx, s.finished, P, y + 60, W - P * 2, t, useImages);
  if (!s.finished.length) { ctx.fillStyle = t.muted; ctx.font = `italic 34px ${SERIF}`; ctx.fillText('No finished books logged this year — yet.', W / 2, y + 100); y += 120; }
  y += 40;

  // favourite read + line of the year — fit what remains
  const footerTop = H - 175; // nothing above the footer may pass this line
  if (s.best && y < footerTop - 160) {
    y += 30;
    ctx.fillStyle = t.gold; ctx.font = `600 20px ${SANS}`; spaced(ctx, 'FAVOURITE READ', W / 2, y, 6);
    ctx.fillStyle = t.fg; ctx.font = `italic 500 50px ${DISPLAY}`;
    const tl = wrap(ctx, s.best.title, W - P * 2.5, 2);
    tl.forEach((l, i) => ctx.fillText(l, W / 2, y + 62 + i * 56));
    y += 62 + (tl.length - 1) * 56;
    ctx.fillStyle = t.muted; ctx.font = `28px ${SERIF}`;
    ctx.fillText(`${s.best.author ? s.best.author + '  ·  ' : ''}${'★'.repeat(Math.floor(s.best.rating))}${s.best.rating % 1 ? '½' : ''}`, W / 2, y + 46);
    y += 70;
  }
  if (s.line && y < footerTop - 140) {
    y += 45;
    ctx.fillStyle = t.gold; ctx.font = `600 20px ${SANS}`; spaced(ctx, 'LINE OF THE YEAR', W / 2, y, 6);
    ctx.fillStyle = t.soft; ctx.font = `italic 38px ${DISPLAY}`;
    const room = Math.max(1, Math.floor((footerTop - (y + 58)) / 48) + 1);
    const ql = wrap(ctx, `“${s.line.text}”`, W - P * 2.6, Math.min(room, 5));
    ql.forEach((l, i) => ctx.fillText(l, W / 2, y + 58 + i * 48));
    y += 58 + ql.length * 48;
  }

  // footer
  ctx.fillStyle = t.gold; ctx.font = `20px ${DISPLAY}`; ctx.fillText('◆', W / 2, H - 135);
  ctx.fillStyle = t.muted; ctx.font = `italic 30px ${DISPLAY}`;
  ctx.fillText(`Bibliophile${s.avg ? `  ·  average rating ${fmtRating(Math.round(s.avg * 10) / 10)}` : ''}`, W / 2, H - 88);

  return new Promise((res, rej) => {
    try { c.toBlob((b) => (b ? res(b) : rej(new Error('empty'))), 'image/png'); } catch (e) { rej(e); }
  });
}

export async function yearCard(year, themeName = 'ivory') {
  await Promise.all([
    `500 80px ${DISPLAY}`, `italic 40px ${DISPLAY}`, `28px ${SERIF}`, `italic 28px ${SERIF}`, `600 20px ${SANS}`,
  ].map((f) => document.fonts?.load(f).catch(() => {})));
  try {
    return await paint(year, themeName, true);
  } catch {
    // A cover image without permission to be re-shared "taints" the canvas — redraw with cloth covers.
    return paint(year, themeName, false);
  }
}

export function yearsWithReading() {
  const ys = new Set([String(new Date().getFullYear())]);
  for (const b of db.books) if (b.finishedAt) ys.add(b.finishedAt.slice(0, 4));
  return [...ys].filter((y) => /^\d{4}$/.test(y)).sort().reverse();
}
