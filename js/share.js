// Quote-card images and Markdown export.
import { db, getBook, itemsForBook, KINDS, STATUSES } from './store.js';

const THEMES = [
  { bg: '#f6f0e4', fg: '#2b2420', accent: '#9a5b2e' },
  { bg: '#1f2a2e', fg: '#f2ede4', accent: '#e0b46c' },
  { bg: '#e7ece4', fg: '#22302a', accent: '#4f7a5f' },
  { bg: '#2a1f2d', fg: '#f4eaf1', accent: '#d48fb5' },
];

function wrap(ctx, text, maxWidth) {
  const out = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const test = line ? line + ' ' + word : word;
      if (ctx.measureText(test).width > maxWidth && line) { out.push(line); line = word; }
      else line = test;
    }
    out.push(line);
  }
  return out;
}

export async function quoteCard(item, themeIndex = 0) {
  const t = THEMES[themeIndex % THEMES.length];
  const W = 1080, H = 1350, pad = 110;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = t.bg; ctx.fillRect(0, 0, W, H);

  const book = getBook(item.bookId);
  const attribution = book ? `${book.title}${book.author ? ' — ' + book.author : ''}` : item.source || '';

  let size = 64, lines;
  for (; size >= 30; size -= 2) {
    ctx.font = `${size}px Georgia, 'Times New Roman', serif`;
    lines = wrap(ctx, item.text, W - pad * 2);
    if (lines.length * size * 1.4 < H - pad * 2 - 260) break;
  }
  const lh = size * 1.4;
  const blockH = lines.length * lh;
  let y = (H - blockH) / 2 - 40;

  ctx.fillStyle = t.accent;
  ctx.font = `bold 180px Georgia, serif`;
  ctx.fillText('“', pad - 20, y - 10);

  ctx.fillStyle = t.fg;
  ctx.font = `${size}px Georgia, 'Times New Roman', serif`;
  for (const l of lines) { y += lh; ctx.fillText(l, pad, y); }

  ctx.fillStyle = t.accent;
  ctx.fillRect(pad, y + 60, 80, 4);
  ctx.font = `italic 36px Georgia, serif`;
  ctx.fillStyle = t.fg;
  const attrLines = wrap(ctx, attribution, W - pad * 2);
  attrLines.slice(0, 2).forEach((l, i) => ctx.fillText(l, pad, y + 120 + i * 48));

  return new Promise((res) => c.toBlob(res, 'image/png'));
}

export function download(filename, data, type = 'text/plain') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export function bookMarkdown(book) {
  const items = itemsForBook(book.id).sort((a, b) => (parseInt(a.page) || 0) - (parseInt(b.page) || 0));
  const lines = [`# ${book.title}`, ''];
  if (book.author) lines.push(`**Author:** ${book.author}  `);
  lines.push(`**Status:** ${STATUSES[book.status] || book.status}  `);
  if (book.rating) lines.push(`**Rating:** ${'★'.repeat(book.rating)}${'☆'.repeat(5 - book.rating)}  `);
  if (book.finishedAt) lines.push(`**Finished:** ${book.finishedAt}  `);
  if (book.tags?.length) lines.push(`**Tags:** ${book.tags.map((t) => '#' + t).join(' ')}  `);
  if (book.review) lines.push('', '## Review', '', book.review);
  const groups = {};
  for (const i of items) (groups[i.kind] ||= []).push(i);
  for (const [kind, list] of Object.entries(groups)) {
    lines.push('', `## ${KINDS[kind]?.label || kind}s`, '');
    for (const i of list) {
      if (kind === 'word') lines.push(`- **${i.text}**${i.note ? ' — ' + i.note : ''}`);
      else {
        lines.push(i.text.split('\n').map((l) => '> ' + l).join('\n'));
        const meta = [i.page && (/^\d/.test(i.page) ? `p. ${i.page}` : i.page), i.chapter, i.favorite && '♥'].filter(Boolean).join(' · ');
        if (meta) lines.push(`> — ${meta}`);
        if (i.note) lines.push('', `*Note:* ${i.note}`);
        if (i.tags?.length) lines.push('', i.tags.map((t) => '#' + t).join(' '));
        lines.push('');
      }
    }
  }
  return lines.join('\n') + '\n';
}

export function allMarkdown() {
  const parts = db.books
    .slice()
    .sort((a, b) => a.title.localeCompare(b.title))
    .map(bookMarkdown);
  const loose = db.items.filter((i) => !i.bookId);
  if (loose.length) {
    parts.push(['# Other quotes & notes', '', ...loose.map((i) => `> ${i.text.replace(/\n/g, '\n> ')}\n> — ${i.source || 'Unknown'}\n`)].join('\n'));
  }
  return parts.join('\n---\n\n');
}
