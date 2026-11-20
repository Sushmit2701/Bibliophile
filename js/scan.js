// Scan a page: read the text in a photo of a book page, on your device (Tesseract, bundled in
// js/vendor/tesseract). Nothing is uploaded. The reader (about 10 MB) is downloaded the first time
// you scan and then kept for offline use.

const BASE = new URL('vendor/tesseract/', import.meta.url).href;
let worker = null;
let loading = null;
let progressFn = () => {};

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Couldn’t load the page reader. Check your connection and try again.'));
    document.head.appendChild(s);
  });
}

async function getWorker() {
  if (worker) return worker;
  loading ||= (async () => {
    if (!window.Tesseract) await loadScript(BASE + 'tesseract.min.js');
    worker = await window.Tesseract.createWorker('eng', 1, {
      workerPath: BASE + 'worker.min.js',
      corePath: BASE,
      langPath: BASE + 'lang',
      gzip: true,
      logger: (m) => progressFn(m),
    });
    return worker;
  })().catch((e) => { loading = null; throw e; });
  return loading;
}

// Photos straight from a phone can be 4000px+; the reader works best around 1600–2200px on the long side.
async function prepare(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(file));
  const scale = Math.min(1, 2200 / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.filter = 'grayscale(1) contrast(1.15)';
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  return canvas;
}

// Returns the page as lines, each with its position on the photo (as fractions, so it scales).
export async function readPage(file, onProgress = () => {}) {
  progressFn = (m) => {
    if (m.status === 'recognizing text') onProgress({ stage: 'read', p: m.progress });
    else if (/load|initiali/i.test(m.status)) onProgress({ stage: 'load', p: m.progress || 0 });
  };
  onProgress({ stage: 'load', p: 0 });
  const [w, canvas] = await Promise.all([getWorker(), prepare(file)]);
  const { data } = await w.recognize(canvas, {}, { blocks: true, text: false });
  const W = canvas.width, H = canvas.height;
  const lines = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) {
    p.lines.forEach((l, i) => {
      const text = (l.text || '').replace(/\s+/g, ' ').trim();
      if (!text || l.confidence < 25 || !/[A-Za-z0-9]/.test(text)) return;
      const { x0, y0, x1, y1 } = l.bbox;
      lines.push({ text, conf: l.confidence, paraStart: i === 0, x: x0 / W, y: y0 / H, w: (x1 - x0) / W, h: (y1 - y0) / H });
    });
  }
  return { lines, image: canvas.toDataURL('image/jpeg', 0.82), ratio: H / W, page: guessPage(lines) };
}

// A line that is just a number near the top or bottom of the page is probably the page number.
function guessPage(lines) {
  const cand = lines.filter((l) => /^\d{1,4}$/.test(l.text) && (l.y < 0.12 || l.y > 0.85));
  return cand.length ? cand[0].text : '';
}

// Join chosen lines into a passage: undo hyphenation at line ends and tidy spacing and quotes.
export function joinLines(lines) {
  let out = '';
  lines.forEach((l, i) => {
    const t = l.text;
    if (!out) { out = t; return; }
    if (l.paraStart && i > 0) { out += '\n\n' + t; return; }
    if (/[A-Za-z]-$/.test(out) && /^[a-z]/.test(t)) out = out.slice(0, -1) + t;
    else out += ' ' + t;
  });
  return out
    .replace(/[|]/g, 'I')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/ {2,}/g, ' ')
    .trim();
}

export async function release() { if (worker) { await worker.terminate(); worker = null; loading = null; } }
