import {
  db, save, onChange, uid, today, addDays, KINDS, STATUSES, ASPECTS, suggestedRating, fmtRating,
  getBook, upsertBook, deleteBook, logSession,
  getItem, itemsForBook, upsertItem, deleteItem, allTags,
  buildReviewQueue, reviewItem, reviewStreak, exportJSON, importJSON,
} from './store.js';
import { importKindle, importReadwise, importGoodreads } from './importers.js';
import { quoteCard, download, bookMarkdown, allMarkdown } from './share.js';
import { hasAI, testKey, tidyLocally, tidyReview, tidyDictation, captionTemplate, reelTemplate, aiCaption, aiReel, aiUsage, resetTimeLocal } from './ai.js';
import { yearCard, yearsWithReading, YEAR_THEMES } from './yearcard.js';
import * as Recs from './recs.js';
import { statsHTML, initChartTooltips } from './stats.js';
import * as Sound from './sound.js';
import * as Spotify from './spotify.js';
import {
  loadCovers, onCoverChange, coverSrc, hasSavedCover, savedCoverCount, ensureCover, ensureAll,
  useUploadedCover, removeCover, clearCovers, exportCovers, importCovers,
  editionCovers, googleCoverOptions, coverFromUrl,
} from './covers.js';

// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nl2br = (s) => esc(s).replace(/\n/g, '<br>');
const parseTags = (s) => [...new Set(String(s || '').split(/[,#]/).map((t) => t.trim().toLowerCase()).filter(Boolean))];
const fmtDate = (s) => {
  if (!s) return '';
  const d = new Date(s.length === 10 ? s + 'T12:00:00' : s);
  return isNaN(d) ? s : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
// Star display with half-star support. Editable stars have two click zones per star (left half = .5, right half = full).
const starFill = (n, i) => (n >= i ? 100 : n >= i - 0.5 ? 50 : 0);
const stars = (n, bookId) => {
  n = Number(n) || 0;
  let h = `<span class="stars ${bookId ? 'editable' : ''}" data-rating="${n}" title="${n ? fmtRating(n) + ' out of 5' : 'Not rated'}">`;
  for (let i = 1; i <= 5; i++) {
    h += `<span class="star" style="--fill:${starFill(n, i)}%">★${bookId ? `<i class="hit l" data-action="rate" data-id="${bookId}" data-value="${i - 0.5}" title="${i - 0.5} stars"></i><i class="hit r" data-action="rate" data-id="${bookId}" data-value="${i}" title="${plural(i, 'star')}"></i>` : ''}</span>`;
  }
  if (bookId) h += `<span class="rating-num">${n ? fmtRating(n) : 'Rate it'}</span>`;
  return h + '</span>';
};
function paintStars(container, n) {
  $$('.star', container).forEach((st, idx) => st.style.setProperty('--fill', starFill(n, idx + 1) + '%'));
  const num = $('.rating-num', container);
  if (num) num.textContent = n ? fmtRating(n) : 'Rate it';
}
document.addEventListener('mouseover', (e) => {
  const hit = e.target.closest('.stars.editable .hit');
  if (hit) paintStars(hit.closest('.stars'), Number(hit.dataset.value));
});
document.addEventListener('mouseout', (e) => {
  const box = e.target.closest('.stars.editable');
  if (box && !box.contains(e.relatedTarget)) paintStars(box, Number(box.dataset.rating));
});

function aspectPanel(b) {
  const a = b.aspects || {};
  const any = Object.values(a).some((v) => v > 0);
  const sug = suggestedRating(a);
  return `
    <details class="aspects" ${any ? 'open' : ''}>
      <summary>Rate in detail <span class="muted small">— score a few aspects, get a suggested overall</span></summary>
      <div class="aspect-rows">
        ${Object.entries(ASPECTS).map(([k, asp]) => `
          <div class="aspect-row">
            <div><b>${asp.label}</b><div class="muted small">${asp.hint}</div></div>
            <div class="dots" role="group" aria-label="${asp.label}">
              ${[1, 2, 3, 4, 5].map((v) => `<button class="dot ${v <= (a[k] || 0) ? 'on' : ''}" data-action="aspect" data-id="${b.id}" data-aspect="${k}" data-value="${v}" title="${v}/5" aria-label="${asp.label} ${v} of 5"></button>`).join('')}
            </div>
          </div>`).join('')}
      </div>
      ${sug ? `<div class="aspect-suggest">
        Suggested overall: <b>${fmtRating(sug)} ★</b>
        ${sug !== b.rating ? `<button class="btn sm" data-action="use-suggested" data-id="${b.id}">Use ${fmtRating(sug)}</button>` : '<span class="muted small">✓ matches your rating</span>'}
      </div>` : ''}
    </details>`;
}

function hashHue(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }

// Cloth-bound colours for books without a cover image: oxblood, bottle green, navy, plum, tobacco, slate, rust, ink.
const CLOTH = ["#5a1a1f", "#1f3a2f", "#1d2a44", "#3f2440", "#5b3b1c", "#2c3b40", "#6b2a1a", "#22262e"];
window.coverFail = (img) => {
  const alts = (img.dataset.alt || '').split('|').filter(Boolean);
  if (!alts.length) return img.remove();
  img.dataset.alt = alts.slice(1).join('|');
  img.src = alts[0];
};
function cover(book, size = '') {
  const cloth = CLOTH[hashHue(book.title || "?") % CLOTH.length];
  const fallback = `<div class="cover-fallback" style="--cloth:${cloth}"><span>${esc(book.title)}</span><small>${esc(book.author)}</small></div>`;
  const src = coverSrc(book);
  if (!src) return `<div class="cover ${size}">${fallback}</div>`;
  // If an image fails, try the next way to get it (relay, then other editions) before showing the cloth cover.
  const relay = (u) => (/covers\.openlibrary\.org/.test(u) ? `https://wsrv.nl/?url=${encodeURIComponent(u)}&w=400&we` : '');
  const alts = /^blob:/.test(src) ? [] : [relay(src), ...(book.coverAlt || []).flatMap((u) => [u, relay(u)])].filter(Boolean);
  return `<div class="cover ${size}"><img src="${esc(src)}" alt="" loading="lazy" data-alt="${esc(alts.join('|'))}" onerror="coverFail(this)">${fallback}</div>`;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

function readFile(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(file); });
}

// ---------- theme ----------
function applyTheme() {
  const t = db.settings.theme;
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

// ---------- modal ----------
const dlg = $('#modal');
let modalSnapshot = '';
let modalDraft = null; // 'item' | 'book' when the open form keeps a draft

// Only typed text counts — changing a dropdown or a style shouldn't lock the window.
function modalText() {
  return $$('#modal-body textarea, #modal-body input:not([type]), #modal-body input[type=text], #modal-body input[type=number], #modal-body input[type=url]')
    .map((el) => el.value.trim()).join('\u0001');
}
const modalDirty = () => dlg.open && modalText() !== modalSnapshot;

// ---- drafts: what you type in a new passage / book form is kept until you save or discard it ----
const DRAFT_KEY = (k) => `bibliophile:draft:${k}`;
function readDraft(k) {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY(k)) || 'null');
    return d && Date.now() - d.at < 14 * 864e5 ? d : null;
  } catch { return null; }
}
function clearDraft(k) { try { localStorage.removeItem(DRAFT_KEY(k)); } catch {} }
function writeDraft(k, form) {
  const values = {};
  for (const el of form.elements) {
    if (!el.name || el.type === 'file' || el.type === 'hidden' || el.type === 'submit' || el.tagName === 'BUTTON') continue;
    if (el.type === 'radio') { if (el.checked) values[el.name] = el.value; }
    else if (el.type === 'checkbox') values[el.name] = el.checked;
    else values[el.name] = el.value;
  }
  const hasText = Object.values(values).some((v) => typeof v === 'string' && v.trim() && !/^\d{4}-\d{2}-\d{2}$/.test(v));
  try { hasText ? localStorage.setItem(DRAFT_KEY(k), JSON.stringify({ at: Date.now(), values })) : clearDraft(k); } catch {}
}
function applyDraft(form, values) {
  for (const [name, v] of Object.entries(values)) {
    const els = form.querySelectorAll(`[name="${name}"]`);
    els.forEach((el) => {
      if (el.type === 'radio') { if (el.value === v && !el.checked) { el.checked = true; el.dispatchEvent(new Event('change')); } }
      else if (el.type === 'checkbox') el.checked = !!v;
      else el.value = v;
    });
  }
  form.bookId?.dispatchEvent(new Event('change'));
}

function openModal(html, onMount, opts = {}) {
  $('#modal-body').innerHTML = html;
  if (!dlg.open) dlg.showModal();
  onMount && onMount($('#modal-body'));
  modalDraft = opts.draft || null;
  const form = $('#modal-body form');
  if (modalDraft && form) {
    const d = opts.restore !== false && readDraft(modalDraft);
    if (d) {
      applyDraft(form, d.values);
      form.insertAdjacentHTML('afterbegin', `<div class="draft-note"><span>Restored what you were writing.</span><button type="button" class="link-btn" data-action="discard-draft">Start fresh</button></div>`);
    }
    let t;
    form.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => writeDraft(modalDraft, form), 250); });
    form.addEventListener('change', () => writeDraft(modalDraft, form));
  }
  modalSnapshot = $('.draft-note', form || document) ? '' : modalText(); // a restored draft counts as unsaved work
  const first = $('#modal-body [autofocus]:not([hidden] *)');
  first && first.focus();
}
// Closing after a successful save (or any deliberate action in code).
function closeModal() { modalDraft = null; dlg.close(); }
// Closing because the person asked to (Cancel / Escape): check first if they'd lose typing.
function requestClose() {
  if (modalDirty() && !confirm('Discard what you’ve written?')) return;
  if (modalDraft) clearDraft(modalDraft);
  closeModal();
}
dlg.addEventListener('click', (e) => {
  if (e.target !== dlg) return; // a tap inside the window
  // A tap outside the window: close only if nothing has been typed.
  if (!modalDirty()) return closeModal();
  dlg.classList.remove('nudge'); void dlg.offsetWidth; dlg.classList.add('nudge');
  toast('Your writing is safe — tap Cancel if you meant to close');
});
dlg.addEventListener('cancel', (e) => { // Escape key / Android back gesture
  if (!modalDirty()) return;
  e.preventDefault();
  requestClose();
});

// ---------- unsaved review text ----------
const reviewDraft = (id) => { try { return localStorage.getItem(`bibliophile:draft:review:${id}`); } catch { return null; } };
function setReviewDraft(id, text) {
  try { text == null ? localStorage.removeItem(`bibliophile:draft:review:${id}`) : localStorage.setItem(`bibliophile:draft:review:${id}`, text); } catch {}
}
document.addEventListener('input', (e) => {
  if (e.target.id === 'review-text') setReviewDraft(e.target.dataset.book, e.target.value);
});

// ---------- router ----------
const routes = {
  '': viewHome,
  library: viewLibrary,
  book: viewBook,
  notes: viewNotes,
  review: viewReview,
  stats: viewStats,
  timer: viewTimer,
  foryou: viewForYou,
  settings: viewSettings,
  clubs: viewClubs,
  club: viewClub,
  join: viewJoin,
};
const NAV_ALIAS = { club: 'clubs', join: 'clubs' };
const ui = { // transient UI state that survives re-renders
  libStatus: 'all', libSort: db.settings.libSort || 'year', libQuery: '',
  nKind: 'all', nQuery: '', nTag: '', nFav: false, nBook: '',
  bookKind: 'all', reviewQueue: null, reviewIdx: 0, revealed: false, dailyOffset: 0,
};

function render() {
  const [route, param] = location.hash.replace(/^#\/?/, '').split('/');
  const view = routes[route] || viewHome;
  const navRoute = NAV_ALIAS[route] || (routes[route] ? route : '');
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === navRoute));
  // The Book club tab appears once you're signed in; personal mode looks exactly as before.
  $$('.nav-club').forEach((a) => { a.hidden = !localStorage.getItem(CLOUD_SESSION) && navRoute !== 'clubs'; });
  const main = $('#main');
  const scroll = window.scrollY;
  const sameRoute = main.dataset.route === location.hash;
  // Keep the cursor where it was if the page redraws while you're typing.
  const active = document.activeElement;
  const keep = sameRoute && active && main.contains(active) && active.id ? { id: active.id, a: active.selectionStart, b: active.selectionEnd } : null;
  main.innerHTML = view(decodeURIComponent(param || ''));
  if (keep) { const el = document.getElementById(keep.id); if (el) { el.focus(); try { el.setSelectionRange(keep.a, keep.b); } catch {} } }
  main.dataset.route = location.hash;
  if (sameRoute) window.scrollTo(0, scroll);
  else { window.scrollTo(0, 0); main.classList.remove('enter'); void main.offsetWidth; main.classList.add('enter'); }
  const due = db.items.length > 0 && !db.reviewLog[today()];
  $$('.review-dot').forEach((d) => d.hidden = !due);
  renderTimerBar(route);
  Sound.show(route === 'timer');
  document.body.classList.toggle('route-timer', route === 'timer');
  // Activity grids open on the most recent weeks.
  $$('.heatmap').forEach((h) => { h.scrollLeft = h.scrollWidth; });
}
window.addEventListener('hashchange', () => {
  // The link from a sign-in email, opened in a tab where the app was already running.
  if (/^#(access_token|error_description)=/.test(location.hash)) {
    loadCloud().then((C) => C.handleRedirect()).then((r) => { if (r) toast(r.ok ? `Signed in as ${r.email} — syncing your library` : r.message); render(); if (r?.ok) afterSignIn(); });
    return;
  }
  if (location.hash.split('/')[1] !== 'review') ui.reviewQueue = null;
  render();
});
onChange(render);

// ============ VIEWS ============

function viewHome() {
  const reading = db.books.filter((b) => b.status === 'reading');
  const year = new Date().getFullYear();
  const finishedThisYear = db.books.filter((b) => b.status === 'finished' && (b.finishedAt || '').startsWith(year)).length;
  const goal = db.settings.yearlyGoal || 0;
  const streak = reviewStreak();
  const reviewedToday = db.reviewLog[today()] || 0;
  const pool = db.items.filter((i) => i.text && i.kind !== 'word');
  const daily = pool.length ? pool[(hashHue(today()) * 7919 + ui.dailyOffset) % pool.length] : null;
  const recent = db.items.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 4);
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  const dateLine = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  if (!db.books.length && !db.items.length) {
    return `
      <section class="hero enter-up">
        <div class="ornament">❦</div>
        <h1>A commonplace book<br><em>for the books you love</em></h1>
        <p class="lede">Keep the books you read, the lines that stopped you, and what you made of them — then let them return to you, a few at a time, so they stay.</p>
        <div class="row gap center wrap">
          <button class="btn primary" data-action="add-book">Add your first book</button>
          <button class="btn" data-action="add-item">Save a passage</button>
        </div>
        <p class="small muted hero-foot">Already highlighting elsewhere? <a href="#/settings">Import from Kindle, Readwise or Goodreads</a></p>
      </section>`;
  }

  return `
    <header class="masthead">
      <div class="eyebrow">${esc(dateLine)}</div>
      <h1>${greet}${db.settings.name ? `, <em>${esc(db.settings.name)}</em>` : ''}</h1>
      <p class="muted">${plural(db.books.length, 'book')} on your shelves · ${plural(db.items.length, 'passage')} kept</p>
    </header>

    ${daily ? featuredPassage(daily) : ''}

    <div class="ledger">
      <a class="ledger-cell" href="#/review">
        <div class="eyebrow">Daily review</div>
        <div class="figure">${reviewedToday ? 'Complete' : plural(Math.min(db.settings.dailyReview, db.items.length), 'passage')}</div>
        <div class="muted small">${streak ? `${plural(streak, 'day')} unbroken` : 'Begin a streak today'} <span class="go">→</span></div>
      </a>
      <div class="ledger-cell">
        <div class="eyebrow">${year} reading</div>
        <div class="figure">${finishedThisYear}${goal ? `<span class="of"> of ${goal}</span>` : ''}</div>
        ${goal ? `<div class="progress"><span style="width:${Math.min(100, (finishedThisYear / goal) * 100)}%"></span></div>
        <div class="muted small">${finishedThisYear >= goal ? 'Goal reached — bravo' : goalPace(finishedThisYear, goal)}</div>` : ''}
      </div>
      <div class="ledger-cell actions-cell">
        <div class="eyebrow">Add to the collection</div>
        <button class="btn primary" data-action="add-item">Save a passage</button>
        <button class="btn" data-action="add-book">Add a book</button>
      </div>
    </div>

    ${homePicks()}

    <section class="section">
      <div class="section-head"><h2>On the nightstand</h2><a href="#/library" class="more">The library →</a></div>
      ${reading.length ? `<div class="reading-list">${reading.map(readingRow).join('')}</div>`
        : `<p class="muted">Nothing on the go. <a href="#/library">Choose something from your shelves</a> or <a href="#" data-action="add-book">add a book</a>.</p>`}
    </section>

    ${recent.length ? `
    <section class="section">
      <div class="section-head"><h2>Lately kept</h2><a href="#/notes" class="more">The notebook →</a></div>
      <div class="items masonry">${recent.map((i) => itemCard(i)).join('')}</div>
    </section>` : ''}
  `;
}

function featuredPassage(i) {
  const book = getBook(i.bookId);
  return `
    <section class="featured enter-up">
      <div class="eyebrow center">Passage of the day</div>
      <blockquote class="featured-quote">${nl2br(i.text)}</blockquote>
      <div class="featured-attr">
        ${book ? `<a href="#/book/${book.id}"><em>${esc(book.title)}</em></a>${book.author ? ` · ${esc(book.author)}` : ''}` : esc(i.source || '')}
      </div>
      <div class="featured-actions">
        <button class="link-btn" data-action="shuffle-daily">Another</button>
        <button class="link-btn" data-action="fav" data-id="${i.id}">${i.favorite ? '♥ Favourite' : '♡ Favourite'}</button>
        <button class="link-btn" data-action="card" data-id="${i.id}">Share</button>
      </div>
    </section>`;
}

function goalPace(done, goal) {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  const frac = (now - start) / (365 * 864e5);
  const expected = goal * frac;
  const diff = Math.round(done - expected);
  return diff >= 0 ? (diff ? `${plural(diff, 'book')} ahead of pace` : 'right on pace') : `${plural(-diff, 'book')} behind pace`;
}

function readingRow(b) {
  const pct = b.pages ? Math.min(100, Math.round((b.currentPage / b.pages) * 100)) : 0;
  return `
    <div class="reading-row">
      <a href="#/book/${b.id}">${cover(b, 'md')}</a>
      <div class="grow">
        <a href="#/book/${b.id}" class="title">${esc(b.title)}</a>
        <div class="byline">${esc(b.author)}</div>
        ${b.pages ? `<div class="progress"><span style="width:${pct}%"></span></div>
          <div class="muted small">p. ${b.currentPage || 0} of ${b.pages} · ${pct}%</div>` : `<div class="muted small">${b.currentPage ? 'p. ' + b.currentPage : ''}</div>`}
      </div>
      <div class="col gap-sm">
        <button class="btn sm" data-action="timer-start" data-id="${b.id}">Start reading</button>
        <button class="btn sm ghost" data-action="log-session" data-id="${b.id}">Log progress</button>
        <button class="btn sm ghost" data-action="add-item" data-book="${b.id}">+ Highlight</button>
      </div>
    </div>`;
}

function itemCard(i, opts = {}) {
  const book = getBook(i.bookId);
  const kind = KINDS[i.kind] || KINDS.highlight;
  const attribution = book
    ? `<a href="#/book/${book.id}">${esc(book.title)}</a>${book.author ? ` <span class="muted">· ${esc(book.author)}</span>` : ''}`
    : i.source ? esc(i.source) : '';
  const meta = [i.page && (/^\d/.test(i.page) ? `p. ${esc(i.page)}` : esc(i.page)), i.chapter && esc(i.chapter)].filter(Boolean).join(' · ');
  const body = i.kind === 'word'
    ? `<div class="word"><strong>${esc(i.text)}</strong>${i.note && !opts.hideMeaning ? `<div class="definition">${nl2br(i.note)}</div>` : ''}${i.context ? `<blockquote class="word-context">${contextWithWord(i.context, i.text)}</blockquote>` : ''}</div>`
    : `<blockquote class="${opts.big ? 'big' : ''}">${nl2br(i.text)}</blockquote>${i.note ? `<div class="note"><span class="note-label">My note</span>${nl2br(i.note)}</div>` : ''}`;
  return `
    <article class="item kind-${i.kind}" data-id="${i.id}">
      <div class="item-top">
        <span class="kind-badge" title="${kind.label}">${i.kind === 'word' ? 'Vocabulary' : kind.label}</span>
        ${meta ? `<span class="muted small">${meta}</span>` : ''}
      </div>
      ${body}
      ${!opts.noAttribution && attribution ? `<div class="attribution">— ${attribution}</div>` : ''}
      ${i.tags?.length ? `<div class="tags">${i.tags.map((t) => `<a class="tag" href="#/notes" data-action="filter-tag" data-tag="${esc(t)}">#${esc(t)}</a>`).join('')}</div>` : ''}
      ${opts.noActions ? '' : `
      <div class="item-actions">
        <button class="icon-btn ${i.favorite ? 'fav' : ''}" data-action="fav" data-id="${i.id}" title="Favorite">${i.favorite ? '♥' : '♡'}</button>
        <button class="icon-btn" data-action="copy" data-id="${i.id}" title="Copy">⧉</button>
        ${i.kind !== 'word' ? `<button class="icon-btn word-btn" data-action="word-from" data-id="${i.id}" title="Save a word from this passage (select it first)">+ Word</button><button class="icon-btn" data-action="card" data-id="${i.id}" title="Share as image">▣</button>` : ''}
        <button class="icon-btn" data-action="edit-item" data-id="${i.id}" title="Edit">✎</button>
        <button class="icon-btn" data-action="delete-item" data-id="${i.id}" title="Delete">🗑</button>
      </div>`}
    </article>`;
}

function shelfBook(b) {
  const n = itemsForBook(b.id).length;
  const when = b.status === 'finished' && b.finishedAt ? new Date(b.finishedAt + 'T12:00:00').toLocaleDateString(undefined, { month: 'short' }) : '';
  return `<a class="shelf-book" href="#/book/${b.id}">
    ${cover(b)}
    <div class="shelf-title">${esc(b.title)}</div>
    <div class="muted small">${esc(b.author)}</div>
    <div class="small shelf-meta">${b.rating ? stars(b.rating) : `<span class="status-pill s-${b.status}">${STATUSES[b.status]}</span>`}${n ? ` <span class="muted">· ${n} ❝</span>` : ''}${when && ui.libSort === 'year' ? ` <span class="muted">· ${when}</span>` : ''}</div>
  </a>`;
}

// "By year read": what you're reading now, then each year's finished books (newest first), then the rest.
function libraryByYear(list) {
  const year = String(new Date().getFullYear());
  const goal = db.settings.yearlyGoal || 0;
  const byRecent = (x, y) => (y.finishedAt || '').localeCompare(x.finishedAt || '') || (y.updatedAt || '').localeCompare(x.updatedAt || '');
  const groups = [];
  const reading = list.filter((b) => b.status === 'reading');
  if (reading.length) groups.push({ key: 'reading', title: 'Reading now', books: reading });
  const finished = list.filter((b) => b.status === 'finished');
  const years = new Map();
  for (const b of finished) { const y = (b.finishedAt || '').slice(0, 4) || 'undated'; if (!years.has(y)) years.set(y, []); years.get(y).push(b); }
  [...years.keys()].filter((y) => y !== 'undated').sort().reverse().forEach((y) => {
    const books = years.get(y).sort(byRecent);
    const pages = books.reduce((t, x) => t + (Number(x.pages) || 0), 0);
    const rated = books.filter((x) => x.rating);
    const avg = rated.length ? rated.reduce((t, x) => t + x.rating, 0) / rated.length : 0;
    groups.push({
      key: y, year: y, title: y, books,
      count: plural(books.length, 'book'),
      meta: [y === year && goal ? `${books.length} of your ${goal}-book goal` : '', pages ? `${pages.toLocaleString()} pages` : '', avg ? `average ${fmtRating(Math.round(avg * 10) / 10)}★` : ''].filter(Boolean).join(' · '),
      progress: y === year && goal ? Math.min(100, (books.length / goal) * 100) : null,
    });
  });
  if (years.has('undated')) groups.push({ key: 'undated', title: 'Finished, date not set', books: years.get('undated'), note: 'Add a finish date (Edit) to place these in a year.' });
  for (const st of ['want', 'paused', 'abandoned']) {
    const books = list.filter((b) => b.status === st);
    if (books.length) groups.push({ key: st, title: STATUSES[st], books: books.sort((x, y) => (y.updatedAt || '').localeCompare(x.updatedAt || '')) });
  }
  return groups.map((g) => `
    <section class="shelf-group ${g.year ? 'year-group' : ''}">
      <div class="shelf-group-head">
        <h2>${esc(g.title)}${g.count ? ` <span class="group-count">${g.count}</span>` : ` <span class="group-count">${g.books.length}</span>`}</h2>
        ${g.meta ? `<span class="muted small">${esc(g.meta)}</span>` : ''}
      </div>
      ${g.progress != null ? `<div class="progress year-progress"><span style="width:${g.progress}%"></span></div>` : ''}
      ${g.note ? `<p class="muted small">${esc(g.note)}</p>` : ''}
      <div class="shelf">${g.books.map(shelfBook).join('')}</div>
    </section>`).join('');
}

function viewLibrary() {
  const counts = { all: db.books.length, top: db.books.filter((b) => (b.rating || 0) >= 4).length };
  for (const b of db.books) counts[b.status] = (counts[b.status] || 0) + 1;
  const q = ui.libQuery.toLowerCase();
  let list = db.books.filter((b) => (ui.libStatus === 'all' || (ui.libStatus === 'top' ? (b.rating || 0) >= 4 : b.status === ui.libStatus))
    && (!q || `${b.title} ${b.author} ${(b.tags || []).join(' ')}`.toLowerCase().includes(q)));
  const sorters = {
    recent: (a, b) => (b.finishedAt || b.updatedAt || '').localeCompare(a.finishedAt || a.updatedAt || ''),
    title: (a, b) => a.title.localeCompare(b.title),
    author: (a, b) => (a.author.split(' ').pop() || '').localeCompare(b.author.split(' ').pop() || ''),
    rating: (a, b) => (b.rating || 0) - (a.rating || 0),
    highlights: (a, b) => itemsForBook(b.id).length - itemsForBook(a.id).length,
  };
  const grouped = ui.libSort === 'year';
  if (!grouped) list.sort(sorters[ui.libSort] || sorters.recent);
  const filters = ['all', 'reading', 'finished', 'want', 'paused', 'abandoned'];

  return `
    <header class="page-head">
      <h1>Library</h1>
      <button class="btn primary" data-action="add-book">+ Add book</button>
    </header>
    <div class="toolbar">
      <div class="chips">
        ${filters.map((s) => `<button class="chip ${ui.libStatus === s ? 'on' : ''}" data-action="lib-status" data-value="${s}">${s === 'all' ? 'All' : STATUSES[s]} <span class="count">${counts[s] || 0}</span></button>`).join('')}
        <button class="chip ${ui.libStatus === 'top' ? 'on' : ''}" data-action="lib-status" data-value="top">★ 4 and up <span class="count">${counts.top}</span></button>
      </div>
      <div class="row gap">
        <input type="search" placeholder="Search books…" value="${esc(ui.libQuery)}" data-input="libQuery">
        <select data-change="libSort" aria-label="Arrange by">
          ${Object.entries({ year: 'By year read', recent: 'Recent', title: 'Title', author: 'Author', rating: 'Rating', highlights: 'Most highlights' }).map(([k, v]) => `<option value="${k}" ${ui.libSort === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
      </div>
    </div>
    ${!list.length ? `<p class="empty">No books here yet.</p>`
      : grouped ? libraryByYear(list)
      : `<div class="shelf">${list.map(shelfBook).join('')}</div>`}
  `;
}

function viewBook(id) {
  const b = getBook(id);
  if (!b) return `<p class="empty">Book not found. <a href="#/library">Back to library</a></p>`;
  const items = itemsForBook(b.id);
  const kinds = [...new Set(items.map((i) => i.kind))];
  const shown = items
    .filter((i) => ui.bookKind === 'all' || i.kind === ui.bookKind)
    .sort((a, c) => (parseFloat(String(a.page).replace(/[^\d.]/g, '')) || 1e9) - (parseFloat(String(c.page).replace(/[^\d.]/g, '')) || 1e9) || a.createdAt.localeCompare(c.createdAt));
  const pct = b.pages ? Math.min(100, Math.round(((b.currentPage || 0) / b.pages) * 100)) : 0;
  const sessions = (b.sessions || []).slice().sort((x, y) => y.date.localeCompare(x.date));
  const daysToRead = b.startedAt && b.finishedAt ? Math.max(1, Math.round((new Date(b.finishedAt) - new Date(b.startedAt)) / 864e5) + 1) : 0;

  return `
    <a href="#/library" class="back">← Library</a>
    <section class="book-head">
      <div class="cover-col">
        ${cover(b, 'lg')}
        <button class="link-btn" data-action="change-cover" data-id="${b.id}">${hasSavedCover(b.id) ? 'Change cover' : 'Choose a cover'}</button>
      </div>
      <div class="grow">
        <h1>${esc(b.title)}</h1>
        <p class="author">${esc(b.author)}${b.year ? ` <span class="muted">· ${esc(b.year)}</span>` : ''}</p>
        <div class="row gap wrap center-v">
          <select data-action-change="status" data-id="${b.id}" class="status-select s-${b.status}">
            ${Object.entries(STATUSES).map(([k, v]) => `<option value="${k}" ${b.status === k ? 'selected' : ''}>${v}</option>`).join('')}
          </select>
          ${stars(b.rating, b.id)}
        </div>
        ${b.status === 'want' ? '' : aspectPanel(b)}
        <dl class="facts">
          ${b.pages ? `<div><dt>Pages</dt><dd>${b.pages}</dd></div>` : ''}
          <div><dt>Format</dt><dd class="cap">${esc(b.format || '—')}</dd></div>
          ${b.startedAt ? `<div><dt>Started</dt><dd>${fmtDate(b.startedAt)}</dd></div>` : ''}
          ${b.finishedAt ? `<div><dt>Finished</dt><dd>${fmtDate(b.finishedAt)}</dd></div>` : ''}
          ${daysToRead ? `<div><dt>Took</dt><dd>${plural(daysToRead, 'day')}</dd></div>` : ''}
        </dl>
        ${b.status === 'reading' && b.pages ? `<div class="progress"><span style="width:${pct}%"></span></div><div class="muted small">p. ${b.currentPage || 0} of ${b.pages} · ${pct}%</div>` : ''}
        ${b.tags?.length ? `<div class="tags">${b.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}</div>` : ''}
        <div class="row gap wrap actions">
          <button class="btn primary" data-action="add-item" data-book="${b.id}">+ Add highlight</button>
          <button class="btn" data-action="timer-start" data-id="${b.id}">Start reading</button>
          <button class="btn" data-action="log-session" data-id="${b.id}">Log reading</button>
          <button class="btn" data-action="edit-book" data-id="${b.id}">Edit</button>
          <button class="btn ghost" data-action="social" data-id="${b.id}">Create a post</button>
          <button class="btn ghost" data-action="export-book" data-id="${b.id}">Export .md</button>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2>My review</h2>${b.review ? `<span class="muted small">${b.reviewUpdatedAt ? 'Edited ' + fmtDate(b.reviewUpdatedAt) : ''}</span>` : ''}</div>
      <div class="card review-box">
        ${(() => { const draft = reviewDraft(b.id); const text = draft ?? b.review; return `
        <textarea id="review-text" data-book="${b.id}" rows="${text ? Math.min(16, text.split('\n').length + 3) : 4}" placeholder="What did you think? What will you remember? Who would you recommend it to?">${esc(text)}</textarea>
        ${draft != null && draft !== b.review ? `<p class="unsaved-note">Unsaved changes — they're kept until you save. <button class="link-btn" data-action="discard-review" data-id="${b.id}">Undo changes</button></p>` : ''}`; })()}
        <div class="voice-row">
          ${micButton('#review-text', 'Speak your review', 'note')}
          <button class="link-btn" data-action="tidy-review" data-id="${b.id}" title="${hasAI() ? 'Edit your spoken notes into clean prose with AI' : 'Basic clean-up (add a free AI key in Settings for a proper edit)'}">✦ Tidy${hasAI() ? ' with AI' : ''}</button>
          <span class="interim muted"></span>
        </div>
        <div class="row gap between center-v">
          <span class="muted small">Prompts: <a href="#" data-action="prompt" data-text="In one sentence, this book is about ">One-line summary</a> · <a href="#" data-action="prompt" data-text="It changed how I think about ">What changed</a> · <a href="#" data-action="prompt" data-text="I'd recommend it to ">Recommend to</a></span>
          <button class="btn primary sm" data-action="save-review" data-id="${b.id}">Save review</button>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="section-head">
        <h2>Highlights & notes <span class="muted">${items.length}</span></h2>
        ${kinds.length > 1 ? `<div class="chips">${['all', ...kinds].map((k) => `<button class="chip ${ui.bookKind === k ? 'on' : ''}" data-action="book-kind" data-value="${k}">${k === 'all' ? 'All' : KINDS[k].label + 's'}</button>`).join('')}</div>` : ''}
      </div>
      ${shown.length ? `<div class="items">${shown.map((i) => itemCard(i, { noAttribution: true })).join('')}</div>`
        : `<p class="empty">No highlights yet. <a href="#" data-action="add-item" data-book="${b.id}">Save the first one</a>.</p>`}
    </section>

    ${sessions.length ? `
    <section class="section">
      <h2>Reading log</h2>
      <table class="log">
        <thead><tr><th>Date</th><th>Pages</th><th>Time</th><th></th></tr></thead>
        <tbody>${sessions.map((s) => `<tr><td>${fmtDate(s.date)}</td><td>${s.fromPage} → ${s.toPage} <span class="muted">(${Math.max(0, s.toPage - s.fromPage)})</span></td><td>${s.minutes ? s.minutes + ' min' : '—'}</td><td><button class="icon-btn" data-action="delete-session" data-id="${b.id}" data-session="${s.id}" title="Remove">×</button></td></tr>`).join('')}</tbody>
      </table>
    </section>` : ''}

    <p class="danger-zone"><button class="btn ghost danger sm" data-action="delete-book" data-id="${b.id}">Delete book</button></p>
  `;
}

function viewNotes() {
  const q = ui.nQuery.toLowerCase();
  const list = db.items.filter((i) => {
    if (ui.nKind !== 'all' && i.kind !== ui.nKind) return false;
    if (ui.nFav && !i.favorite) return false;
    if (ui.nTag && !(i.tags || []).includes(ui.nTag)) return false;
    if (ui.nBook === '_none' && i.bookId) return false;
    if (ui.nBook && ui.nBook !== '_none' && i.bookId !== ui.nBook) return false;
    if (q) {
      const b = getBook(i.bookId);
      const hay = `${i.text} ${i.note} ${i.context || ''} ${i.source} ${(i.tags || []).join(' ')} ${b ? b.title + ' ' + b.author : ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const tags = allTags();
  const books = db.books.filter((b) => itemsForBook(b.id).length).sort((a, b) => a.title.localeCompare(b.title));

  return `
    <header class="page-head">
      <h1>Notebook</h1>
      <button class="btn primary" data-action="add-item">+ New</button>
    </header>
    <div class="toolbar">
      <input type="search" class="grow" placeholder="Search every highlight, note and word…" value="${esc(ui.nQuery)}" data-input="nQuery" autofocus>
      <div class="row gap wrap">
        <select data-change="nKind">
          <option value="all">All types</option>
          ${Object.entries(KINDS).map(([k, v]) => `<option value="${k}" ${ui.nKind === k ? 'selected' : ''}>${v.label}s</option>`).join('')}
        </select>
        <select data-change="nBook">
          <option value="">All sources</option>
          <option value="_none" ${ui.nBook === '_none' ? 'selected' : ''}>Not from a book</option>
          ${books.map((b) => `<option value="${b.id}" ${ui.nBook === b.id ? 'selected' : ''}>${esc(b.title)}</option>`).join('')}
        </select>
        <button class="chip ${ui.nFav ? 'on' : ''}" data-action="toggle-fav-filter">♥ Favorites</button>
      </div>
    </div>
    ${tags.length ? `<div class="chips tag-cloud">${tags.slice(0, 30).map(([t, n]) => `<button class="chip sm ${ui.nTag === t ? 'on' : ''}" data-action="filter-tag" data-tag="${esc(t)}">#${esc(t)} <span class="count">${n}</span></button>`).join('')}</div>` : ''}
    <p class="muted small">${plural(list.length, 'result')}</p>
    ${list.length ? `<div class="items masonry">${list.map((i) => itemCard(i)).join('')}</div>` : `<p class="empty">Nothing matches.</p>`}
  `;
}

function viewReview() {
  if (!ui.reviewQueue) {
    const doneToday = (db.reviewLog[today()] || 0) >= db.settings.dailyReview;
    ui.reviewQueue = doneToday ? [] : buildReviewQueue(); ui.reviewIdx = 0; ui.revealed = false;
  }
  const queue = ui.reviewQueue;
  const streak = reviewStreak();
  if (!db.items.length) {
    return `<header class="page-head"><h1>Daily review</h1></header>
      <p class="empty">Save a few highlights first — they'll come back to you here, a handful a day, spaced out so you remember them.</p>`;
  }
  if (ui.reviewIdx >= queue.length) {
    return `
      <div class="review-done">
        <div class="ornament">❦</div>
        <h1>That's today's review</h1>
        <p class="muted">${streak ? `${plural(streak, 'day')} unbroken. ` : ''}More will be waiting tomorrow.</p>
        <div class="row gap center">
          <button class="btn" data-action="review-more">Review a few more</button>
          <a class="btn primary" href="#/">Home</a>
        </div>
      </div>`;
  }
  const item = getItem(queue[ui.reviewIdx]);
  if (!item) { ui.reviewIdx++; return viewReview(); }
  const isWord = item.kind === 'word';
  return `
    <header class="page-head">
      <h1>Daily review</h1>
      <span class="muted">${ui.reviewIdx + 1} / ${queue.length}${streak ? ` · ${plural(streak, 'day')} streak` : ''}</span>
    </header>
    <div class="progress thin"><span style="width:${(ui.reviewIdx / queue.length) * 100}%"></span></div>
    <div class="review-stage">
      ${isWord && !ui.revealed ? `
        <article class="item kind-word review-card">
          <div class="item-top"><span class="kind-badge">Vocabulary</span></div>
          <div class="word"><strong>${esc(item.text)}</strong>${item.context ? `<blockquote class="word-context">${contextWithWord(item.context, item.text)}</blockquote>` : ''}</div>
          <p class="muted">Do you remember what it means?</p>
          <button class="btn" data-action="reveal">Show meaning</button>
        </article>`
        : `<div class="review-card">${itemCard(item, { big: true, noActions: true })}</div>`}
      <div class="review-buttons">
        <button class="btn" data-action="review" data-value="again" title="Show it again in a couple of days">Again soon</button>
        <button class="btn primary" data-action="review" data-value="good" title="Spaces it out further">Good</button>
        <button class="btn" data-action="review" data-value="later" title="Push it far into the future">Much later</button>
        <button class="btn ghost" data-action="review" data-value="never" title="Stop showing this in reviews">Retire</button>
      </div>
      <div class="row gap center small">
        <a href="#" data-action="fav" data-id="${item.id}">${item.favorite ? '♥ Favorited' : '♡ Favorite'}</a>
        <a href="#" data-action="edit-item" data-id="${item.id}">✎ Add a thought</a>
        ${item.kind !== 'word' ? `<a href="#" data-action="card" data-id="${item.id}">▣ Share</a>` : ''}
      </div>
    </div>`;
}

let statsEnriching = false;
function viewStats() {
  // Genres come from Open Library subjects; look them up quietly for books that don't have them yet.
  if (!statsEnriching && db.books.some((b) => !b.ol?.at)) {
    statsEnriching = true;
    Recs.enrichLibrary().then((n) => { if (n && location.hash.startsWith('#/stats')) render(); }).catch(() => {});
  }
  const live = db.timer ? timerMs() / 60000 : 0;
  return statsHTML(live, { fmtDate });
}

function viewSettings() {
  const s = db.settings;
  const bytes = new Blob([JSON.stringify(db)]).size;
  return `
    <header class="page-head"><h1>Settings</h1></header>
${accountSection()}

    <section class="card section">
      <h2>Preferences</h2>
      <form class="form" data-form="settings">
        <label>Your name <input name="name" value="${esc(s.name)}" placeholder="for the greeting"></label>
        <label>Yearly reading goal (books) <input name="yearlyGoal" type="number" min="0" value="${s.yearlyGoal}"></label>
        <label>Daily reading goal (minutes) <input name="dailyMinutes" type="number" min="5" max="600" value="${s.dailyMinutes || 30}"></label>
        <label>Passages per daily review <input name="dailyReview" type="number" min="1" max="50" value="${s.dailyReview}"></label>
        <label>Theme
          <select name="theme">${Object.entries({ auto: 'Follow device', light: 'Soft Ivory (light)', dark: 'Night Reading (dark)' }).map(([k, v]) => `<option value="${k}" ${s.theme === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        </label>
        <button class="btn primary">Save</button>
      </form>
    </section>

    <section class="card section">
      <h2>Import</h2>
      <p class="muted small">Duplicates are skipped, so it's safe to re-import an updated file.</p>
      <div class="import-grid">
        <label class="import-box"><b>Kindle</b><span class="muted small">My Clippings.txt (on your Kindle over USB, in /documents)</span><input type="file" accept=".txt" data-import="kindle"></label>
        <label class="import-box"><b>Readwise</b><span class="muted small">CSV from readwise.io/export</span><input type="file" accept=".csv" data-import="readwise"></label>
        <label class="import-box"><b>Goodreads</b><span class="muted small">CSV from My Books → Import/Export</span><input type="file" accept=".csv" data-import="goodreads"></label>
        <label class="import-box"><b>Bibliophile backup</b><span class="muted small">.json file exported below (merges)</span><input type="file" accept=".json" data-import="json"></label>
      </div>
    </section>

    <section class="card section" id="spotify-settings">
      <h2>Spotify <span class="muted small">optional · Premium</span></h2>
      <p class="muted small">Play your own playlists in the reading room, with music that pauses when you pause the timer. Spotify only lets apps do this through your own free "developer app" — a one-time setup of about ten minutes:</p>
      <ol class="setup-steps">
        <li>Open <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">developer.spotify.com/dashboard</a>, sign in with your Spotify account and accept the terms.</li>
        <li>Click <b>Create app</b>. Name: <i>Bibliophile</i>. Description: <i>Reading room music</i>.</li>
        <li>Under <b>Redirect URIs</b>, paste exactly this and click <b>Add</b>:
          <div class="copy-row"><code id="sp-redirect">${esc(Spotify.redirectUri())}</code><button type="button" class="btn sm" data-action="copy-redirect">Copy</button></div></li>
        <li>Under <b>Which API/SDKs</b>, tick <b>Web API</b> and <b>Web Playback SDK</b>, agree, and <b>Save</b>.</li>
        <li>Open the app's <b>Settings</b>, copy the <b>Client ID</b> and paste it below. (You don't need the client secret.)</li>
        <li>If Spotify later says your account isn't registered: in the app's <b>User Management</b>, add your name and the email of your Spotify account.</li>
      </ol>
      <form class="form" data-form="spotify">
        <label>Client ID <input name="spotifyClientId" autocomplete="off" spellcheck="false" value="${esc(s.spotifyClientId || '')}" placeholder="32 letters and numbers"></label>
        <div class="row gap wrap center-v">
          <button class="btn">Save</button>
          ${s.spotifyClientId ? (Spotify.isConnected()
            ? '<span class="sp-ok">✓ Connected</span><button type="button" class="btn ghost danger" data-action="sp-disconnect">Disconnect</button>'
            : '<button type="button" class="btn primary" data-action="sp-connect">Connect Spotify</button>') : ''}
        </div>
      </form>
      <p class="muted small">Your Spotify sign-in stays in this browser and is never put in backups. Free calming sounds and radio work without any of this.</p>
    </section>

    <section class="card section">
      <h2>AI assistant <span class="muted small">optional</span></h2>
      <p class="muted small">Used to tidy what you dictate (notes and reviews become clear sentences; passages read from a book only get punctuation), for <b>Tidy with AI</b> on reviews and <b>Create a post</b> (captions and reel scripts). It uses Google's Gemini, which has a free tier: get a key at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> (sign in with Google, click <i>Create API key</i>), then paste it here.</p>
      <p class="muted small">The key is stored only in this browser and is never included in backups. Text is sent to Google only when you press an AI button. On the free tier, Google may use what you send to improve its products — don't send anything private.</p>
      <p class="muted small"><b>It's free:</b> you can't be charged unless you add a card (billing) to your Google project yourself. Google's free allowance is small and changes often — roughly a few hundred requests a day on the "Lite" models the app uses. When it runs out, the app carries on without AI until it resets.</p>
      <form class="form" data-form="ai">
        <label>Gemini API key <input name="geminiKey" type="password" autocomplete="off" value="${esc(s.geminiKey || '')}" placeholder="AIza…"></label>
        <label class="check"><input type="checkbox" name="autoTidy" ${s.autoTidy !== false ? 'checked' : ''}> Tidy dictation automatically when I stop speaking</label>
        ${s.geminiKey ? (() => { const u = aiUsage(); return `<p class="ai-usage">${u.model ? `Using <b>${esc(u.model)}</b> · ` : ''}${plural(u.today, 'AI request')} today · free allowance resets around ${resetTimeLocal()}</p>`; })() : ''}
        <details class="advanced"><summary>Advanced</summary>
          <label>Model <input name="geminiModel" value="${esc(s.geminiModelManual ? s.geminiModel || '' : '')}" placeholder="leave empty — the app picks the free model with the biggest allowance"></label>
        </details>
        <div class="row gap wrap">
          <button class="btn primary">Save key</button>
          <button type="button" class="btn" data-action="test-ai">Test it</button>
          ${s.geminiKey ? '<button type="button" class="btn ghost danger" data-action="remove-ai">Remove key</button>' : ''}
        </div>
      </form>
    </section>

    <section class="card section">
      <h2>Covers</h2>
      <p class="muted small">${savedCoverCount()} of ${plural(db.books.length, 'book')} have their cover saved in the app, so they show offline and appear in your year image. Covers come from Open Library, then Google Books, and are downloaded through <a href="https://wsrv.nl" target="_blank" rel="noopener">wsrv.nl</a>, a free image relay. Saved covers are included in your backup file.</p>
      <button class="btn" data-action="save-all-covers">Save all covers</button>
    </section>

    <section class="card section">
      <h2>Backup & export</h2>
      <p class="muted small">Your data lives only in this browser (${(bytes / 1024).toFixed(1)} KB). Export a backup now and then — especially before clearing browser data or switching devices.${db.lastBackup ? ` Last backup: ${fmtDate(db.lastBackup)}.` : ''}</p>
      <div class="row gap wrap">
        <button class="btn primary" data-action="export-json">Download backup (.json)</button>
        <button class="btn" data-action="export-md">Export everything as Markdown</button>
        <label class="btn ghost">Restore (replace all)…<input type="file" accept=".json" data-import="json-replace" hidden></label>
      </div>
    </section>

    <section class="card section">
      <h2>Keyboard shortcuts</h2>
      <ul class="shortcuts">
        <li><kbd>n</kbd> new highlight</li><li><kbd>b</kbd> new book</li><li><kbd>/</kbd> search notebook</li>
        <li><kbd>r</kbd> daily review</li><li><kbd>t</kbd> reading timer</li><li><kbd>1</kbd>–<kbd>3</kbd> answer in review</li>
      </ul>
    </section>

    <p class="danger-zone"><button class="btn ghost danger sm" data-action="wipe">Erase all data</button></p>
  `;
}

// ============ ACCOUNT & SYNC (optional) ============
// Personal mode is the default: no account, and the sync code isn't even loaded.
let Cloud = null;
const CLOUD_SESSION = 'bibliophile:cloud-session';
async function loadCloud() {
  if (Cloud) return Cloud;
  const m = await import('./cloud.js');
  m.init({
    onChange: refreshAccount,
    // Save covers for books that arrived from another device (only when there's something new to fetch).
    onPulled: (books) => {
      for (const c of books) {
        const b = !c.deleted && getBook(c.id);
        if (!b) continue;
        if (c.coverChanged && b.cover) ensureCover(b, { force: true });
        else if (c.isNew && b.cover && !hasSavedCover(b.id)) ensureCover(b);
      }
    },
  });
  Cloud = m;
  return m;
}
// Sync status changes redraw only the Account section, so nothing else on Settings is disturbed.
function refreshAccount() {
  const el = $('#account');
  if (!el) return;
  if (el.contains(document.activeElement) && document.activeElement.matches('input')) {
    const line = $('.sync-line', el), st = Cloud.getStatus();
    if (line && st.signedIn) line.innerHTML = $('.sync-line', new DOMParser().parseFromString(accountSection(), 'text/html'))?.innerHTML || line.innerHTML;
    return;
  }
  const open = $('details', el)?.open;
  el.outerHTML = accountSection();
  if (open && $('#account details')) $('#account details').open = true;
}
const cloudWanted = () => !!localStorage.getItem(CLOUD_SESSION) || !!localStorage.getItem('bibliophile:cloud-config') || ui.cloudOpen;
const ago = (iso) => {
  if (!iso) return 'not yet';
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : fmtDate(iso);
};

function accountSection() {
  const st = Cloud?.getStatus();
  const head = `<h2>Account & sync <span class="muted small">optional</span></h2>`;
  if (!st || (!st.signedIn && !ui.cloudOpen && !st.configured)) {
    return `<section class="card section" id="account">${head}
      <p class="mode-line"><span class="mode-dot"></span><b>Personal mode</b> · no account, everything stays on this device.</p>
      <p class="muted small">If you'd like your library on your phone and your computer together, you can sign in to sync it — and later share a book club with friends. Sharing is always your choice, item by item. You can return to personal mode at any time.</p>
      <button class="btn" data-action="cloud-open">Set up sync…</button>
    </section>`;
  }
  if (st.signedIn) {
    return `<section class="card section" id="account">${head}
      <p class="mode-line"><span class="mode-dot on"></span>Signed in as <b>${esc(st.email)}</b> · your library syncs across your devices.</p>
      <p class="muted small sync-line">${st.syncing ? 'Syncing…' : `Last synced ${ago(st.lastSync)}`}${st.error ? ` · <span class="sync-err">${esc(st.error)}</span>` : ''}</p>
      ${st.guard ? `<div class="sync-guard">
        <p><b>Sync paused to protect your library.</b> This device is missing ${st.guard.deletes} books and passages that your other devices still have. If this browser's storage was cleared, restore them. If you really deleted them, carry on.</p>
        <div class="row gap wrap"><button class="btn primary" data-action="cloud-restore">Restore from my other devices</button><button class="btn ghost danger" data-action="cloud-allow-deletes">Delete them everywhere</button></div>
      </div>` : ''}
      <div class="row gap wrap">
        <button class="btn" data-action="cloud-sync" ${st.syncing ? 'disabled' : ''}>Sync now</button>
        <button class="btn ghost" data-action="cloud-signout">Sign out (back to personal mode)</button>
      </div>
      <p class="muted small">Signing out keeps everything on this device. Your Gemini key never leaves this browser, and cover photos you uploaded yourself stay on the device you added them on (covers found online appear everywhere).</p>
      <details class="advanced"><summary>Delete my data</summary>
        <div class="row gap wrap">
          <button class="btn ghost danger sm" data-action="cloud-delete-copy">Delete my cloud copy and sign out</button>
          <button class="btn ghost danger sm" data-action="cloud-delete-account">Delete my account</button>
        </div>
        <p class="muted small">Both keep everything on this device. Deleting your account removes your sign-in and everything stored for it.</p>
      </details>
    </section>`;
  }
  // Not signed in: set up the project, then sign in.
  const setup = `<form class="form" data-form="cloud-config">
      <p class="muted small">Sync uses your own free <a href="https://supabase.com" target="_blank" rel="noopener">Supabase</a> project, so your data sits in a database only you control. Follow <a href="https://github.com/sushmit2701/bibliophile/blob/claude/personal-reading-app-8byml4/SYNC_SETUP.md" target="_blank" rel="noopener">the setup guide</a> (about 15 minutes, once), then paste your project's details here.</p>
      <label>Project URL <input name="url" autocomplete="off" spellcheck="false" placeholder="https://abcd1234.supabase.co" value="${esc(Cloud?.config()?.url || '')}"></label>
      <label>Anon public key <input name="anonKey" autocomplete="off" spellcheck="false" placeholder="eyJhbGciOi… or sb_publishable_…" value="${esc(Cloud?.config()?.anonKey || '')}"></label>
      <div class="row gap wrap"><button class="btn primary">Save</button>${st.configured ? '<button type="button" class="btn ghost" data-action="cloud-forget-config">Remove</button>' : ''}<button type="button" class="btn ghost" data-action="cloud-close">Stay in personal mode</button></div>
    </form>`;
  if (!st.configured) return `<section class="card section" id="account">${head}${setup}</section>`;
  const signin = st.pendingEmail
    ? `<form class="form" data-form="cloud-code">
        <p class="muted small">We've emailed a sign-in link to <b>${esc(st.pendingEmail)}</b>. Open the email on this device and tap <b>Sign in</b>. If the email also shows a code, you can type it here instead.</p>
        <label>Code <span class="muted small">if your email has one</span> <input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="123456" autofocus></label>
        <div class="row gap wrap"><button class="btn primary">Sign in</button><button type="button" class="btn ghost" data-action="cloud-email-cancel">Use a different email</button></div>
      </form>`
    : `${st.google ? '<button class="btn google-btn" data-action="cloud-google"><span class="g">G</span> Continue with Google</button><p class="or-line muted small">or</p>' : ''}
      <form class="form" data-form="cloud-email">
        <label>Email <input name="email" type="email" autocomplete="email" placeholder="you@example.com"></label>
        <div class="row gap wrap"><button class="btn primary">Email me a sign-in link</button></div>
      </form>`;
  return `<section class="card section" id="account">${head}
    <p class="mode-line"><span class="mode-dot"></span><b>Personal mode</b> · sign in to start syncing.</p>
    <p class="muted small">Your library on this device will be combined with anything already in your account; nothing is lost. If the same book was changed on two devices, the most recent change is kept.</p>
    ${signin}
    ${st.builtIn ? '' : `<details class="advanced"><summary>Sync server</summary>${setup}</details>`}
  </section>`;
}

// ============ BOOK CLUBS (needs sync) ============
let Clubs = null;
async function loadClubs() {
  await loadCloud();
  Clubs ||= await import('./clubs.js');
  return Clubs;
}
const signedInLocally = () => !!localStorage.getItem(CLOUD_SESSION);
// Fetch club data in the background at most every 20 s per page, then redraw if you're still there.
const clubFetch = {};
function freshen(key, fn) {
  const f = clubFetch[key] ||= { at: 0, busy: false, err: '' };
  if (f.busy || Date.now() - f.at < 20000) return f;
  f.busy = true;
  const here = location.hash;
  loadClubs().then(() => fn()).then(() => { f.err = ''; }).catch((e) => { f.err = e.message; })
    .finally(() => { f.busy = false; f.at = Date.now(); if (location.hash === here) render(); });
  return f;
}
const refetch = (key) => { if (clubFetch[key]) clubFetch[key].at = 0; };
const initials = (n) => esc(String(n || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase());
const clubHead = (sub = '') => `<header class="page-head"><h1>Book club</h1><p class="lede muted">${sub || 'Read together with friends: one book, everyone\'s progress, the passages you choose to share, and a deadline to keep you going.'}</p></header>`;

function viewClubs() {
  if (!signedInLocally()) {
    return clubHead() + `<section class="card section club-intro">
      <h2>Read with friends</h2>
      <p>Start a book club with up to ${10} friends, or join one from an invite link.</p>
      <ul class="club-points">
        <li>See how far everyone has got in the book you're reading together.</li>
        <li>Share the passages you choose. Everything else stays private, as it is now.</li>
        <li>Agree goals and deadlines, with a nudge before they arrive.</li>
      </ul>
      <p class="muted small">Book clubs use sync, so you'll need to sign in first. Your own library stays private: nothing is shared unless you share it.</p>
      <a class="btn primary" href="#/settings" data-action="cloud-open-from-club">Sign in to start</a>
    </section>`;
  }
  const f = freshen('list', () => Clubs.refreshList());
  const list = Clubs?.cachedList();
  const myName = Clubs?.cachedName() || db.settings.name || '';
  const cards = list?.length ? `<div class="club-grid">${list.map((c) => `
      <a class="card club-card" href="#/club/${esc(c.id)}">
        <span class="club-mark">❧</span>
        <h3>${esc(c.name)}</h3>
        ${c.description ? `<p class="muted small">${esc(c.description)}</p>` : ''}
        <span class="club-meta">${plural(Number(c.members), 'member')}${c.role === 'owner' ? ' · you run it' : ''}</span>
      </a>`).join('')}</div>` : '';
  const status = !list && f.busy ? '<p class="muted">Loading your book clubs…</p>'
    : f.err ? `<p class="sync-err small">${esc(f.err)} <a href="#" data-action="clubs-retry">Try again</a></p>` : '';
  return clubHead() + status + cards + `
    <section class="card section">
      <details class="advanced club-new" ${list && !list.length ? 'open' : ''}><summary>Start a book club</summary>
        <form class="form" data-form="club-new">
          <label>Club name <input name="name" maxlength="60" required placeholder="e.g. Sunday Readers"></label>
          <label>What it's about<textarea name="description" maxlength="500" rows="2" placeholder="Slow classics, one a month"></textarea></label>
          <label>Your name in book clubs <input name="me" maxlength="40" required value="${esc(myName)}" placeholder="How friends will see you"></label>
          <button class="btn primary">Create club</button>
        </form>
      </details>
      <p class="muted small">Got an invite link? Just open it. Clubs hold up to ${10} people.</p>
    </section>`;
}

function viewClub(id) {
  if (!signedInLocally()) return viewClubs();
  const f = freshen('club:' + id, () => Clubs.refreshClub(id));
  const c = Clubs?.cachedClub(id);
  if (!c) {
    if (f.err) return clubHead(' ') + `<p class="empty">${esc(f.err)} <a href="#/clubs">Back to your book clubs</a></p>`;
    return clubHead(' ') + '<p class="muted">Loading…</p>';
  }
  const owner = c.role === 'owner';
  const members = c.members || [];
  const full = members.length >= 10;
  const link = Clubs.inviteLink(c.invite_code);
  return `
    <a href="#/clubs" class="back">← Book clubs</a>
    <header class="page-head club-head"><h1>${esc(c.name)}</h1>${c.description ? `<p class="lede muted">${esc(c.description)}</p>` : ''}</header>
    ${f.err ? `<p class="sync-err small">${esc(f.err)}</p>` : ''}
    <section class="card section">
      <h2>Members <span class="muted small">${members.length} of 10</span></h2>
      <ul class="member-list">${members.map((m) => {
        const me = m.user_id === c.me;
        return `<li><span class="avatar">${initials(m.name)}</span>
          <span class="m-name">${esc(m.name)}${me ? ' <span class="muted small">(you)</span>' : ''}</span>
          ${m.role === 'owner' ? '<span class="tag-pill">runs the club</span>' : ''}
          ${me ? '<button class="link-btn small" data-action="club-myname">Change my name</button>' : ''}
          ${owner && !me ? `<button class="link-btn small danger" data-action="club-remove" data-id="${esc(c.id)}" data-user="${esc(m.user_id)}" data-name="${esc(m.name)}">Remove</button>` : ''}
        </li>`;
      }).join('')}</ul>
    </section>
    <section class="card section">
      <h2>Invite friends</h2>
      ${full ? '<p class="muted">The club is full (10 people).</p>' : `
        <p class="muted small">Anyone with this link can join until the club has 10 people. Send it only to people you want in the club.</p>
        <div class="copy-row"><code class="invite-link">${esc(link)}</code></div>
        <div class="row gap wrap">
          <button class="btn primary" data-action="club-copy" data-link="${esc(link)}">Copy link</button>
          ${navigator.share ? `<button class="btn" data-action="club-share" data-link="${esc(link)}" data-name="${esc(c.name)}">Share…</button>` : ''}
          ${owner ? `<button class="btn ghost" data-action="club-reset" data-id="${esc(c.id)}">Make a new link</button>` : ''}
        </div>
        ${owner ? '<p class="muted small">Making a new link stops the old one from working. People already in the club stay.</p>' : ''}`}
    </section>
    <section class="card section club-soon">
      <h2>Reading together <span class="muted small">coming next</span></h2>
      <p class="muted">Soon you'll pick a book to read together here, see everyone's progress, share passages from your notebook, and set goals and deadlines.</p>
    </section>
    <section class="card section">
      ${owner ? `<details class="advanced"><summary>Edit club</summary>
        <form class="form" data-form="club-edit">
          <input type="hidden" name="id" value="${esc(c.id)}">
          <label>Club name <input name="name" maxlength="60" required value="${esc(c.name)}"></label>
          <label>What it's about <textarea name="description" maxlength="500" rows="2">${esc(c.description)}</textarea></label>
          <button class="btn primary">Save</button>
        </form>
      </details>` : ''}
      <p class="club-leave"><button class="btn ghost danger sm" data-action="club-leave" data-id="${esc(c.id)}" data-owner="${owner ? 1 : ''}" data-n="${members.length}">Leave this club</button></p>
    </section>`;
}

function viewJoin(code) {
  const st = Cloud?.getStatus();
  if (!Cloud) { loadCloud().then(render); return clubHead(' ') + '<p class="muted">Opening your invite…</p>'; }
  if (!st.configured) {
    return clubHead('You\'ve been invited to a book club.') + `<section class="card section">
      <p>This copy of Bibliophile isn't connected to a book club server yet, so it can't open the invite.</p>
      <p class="muted small">Ask the person who invited you to send the link from their copy of the app, or set up sync yourself in Settings.</p>
      <a class="btn" href="#/settings">Settings</a></section>`;
  }
  const key = 'join:' + code;
  const f = clubFetch[key] ||= { at: 0, busy: false, err: '', data: undefined };
  if (!f.busy && f.data === undefined && !f.err) {
    f.busy = true;
    loadClubs().then(() => Clubs.preview(code, st.signedIn)).then((d) => { f.data = d; }).catch((e) => { f.err = e.message; })
      .finally(() => { f.busy = false; if (location.hash === '#/join/' + code) render(); });
  }
  if (f.busy || f.data === undefined && !f.err) return clubHead(' ') + '<p class="muted">Opening your invite…</p>';
  if (f.err || !f.data) return clubHead(' ') + `<section class="card section"><p>${f.err ? esc(f.err) : 'This invite link doesn\'t work any more. Ask for a new one.'}</p><a class="btn" href="#/clubs">Book clubs</a></section>`;
  const c = f.data;
  const intro = `<section class="card section join-card">
      <span class="club-mark">❧</span>
      <p class="muted small">You've been invited to join</p>
      <h2>${esc(c.name)}</h2>
      ${c.description ? `<p class="muted">${esc(c.description)}</p>` : ''}
      <p class="club-meta">${plural(Number(c.members), 'member')} so far · up to 10</p>`;
  if (c.member) return clubHead(' ') + intro + `<a class="btn primary" href="#/club/${esc(c.id)}">You're in — open the club</a></section>`;
  if (Number(c.members) >= 10) return clubHead(' ') + intro + '<p>Sorry, this club is full.</p></section>';
  if (!st.signedIn) {
    return clubHead(' ') + intro + `
      <p class="muted small">To join, sign in first. Your own library stays private; only what you choose to share is shared with the club.</p>
      <button class="btn primary" data-action="club-signin-to-join" data-code="${esc(code)}">Sign in to join</button></section>`;
  }
  return clubHead(' ') + intro + `
    <form class="form" data-form="club-join">
      <input type="hidden" name="code" value="${esc(code)}">
      <label>Your name in book clubs <input name="me" maxlength="40" required value="${esc(Clubs?.cachedName() || db.settings.name || '')}" placeholder="How friends will see you"></label>
      <button class="btn primary">Join the club</button>
    </form>
    <p class="muted small">Members see your name, your progress in the club's book, and the passages you share. Nothing else from your library.</p>
  </section>`;
}

// After signing in from an invite, go back to it.
function afterSignIn() {
  const code = localStorage.getItem('bibliophile:pending-join');
  if (!code) return;
  localStorage.removeItem('bibliophile:pending-join');
  delete clubFetch['join:' + code];
  location.hash = '#/join/' + code;
}
function clearClubData() {
  localStorage.removeItem('bibliophile:clubs-cache');
  Clubs?.clearCache();
  for (const k of Object.keys(clubFetch)) delete clubFetch[k];
}

// ============ READING TIMER ============
// The timer is stored as timestamps, so it keeps counting if you close the app or lock your phone.
function timerMs() {
  const t = db.timer;
  if (!t) return 0;
  return t.elapsed + (t.startedAt ? Date.now() - t.startedAt : 0);
}
function fmtClock(ms) {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const z = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${z(m)}:${z(sec)}` : `${z(m)}:${z(sec)}`;
}
function tickTimer() {
  const t = db.timer;
  focusTick();
  const clock = t ? fmtClock(timerMs()) : '';
  $$('.timer-clock').forEach((el) => { el.textContent = clock; });
  const f = t?.focus;
  if (f) {
    const left = focusLeft();
    $$('.focus-left').forEach((el) => { el.textContent = fmtClock(Math.max(0, left)); });
    $$('.focus-bar span').forEach((el) => { el.style.width = `${Math.min(100, 100 - (left / (f.work * 60000)) * 100)}%`; });
  }
  document.title = f?.phase === 'break' ? `Break ${fmtClock(Math.max(0, focusLeft()))} · Bibliophile`
    : t && t.startedAt ? `${clock} · ${getBook(t.bookId)?.title || 'Reading'}` : 'Bibliophile';
}

// ============ FOCUS BLOCKS (Pomodoro) ============
// Read for a set time, a bell rings, take a short break (every few blocks a longer one).
// Break time is never counted as reading: the reading clock is stopped during breaks.
const FOCUS_PRESETS = { '25/5': { work: 25, brk: 5 }, '50/10': { work: 50, brk: 10 }, '90/15': { work: 90, brk: 15 } };
const focusCfg = () => ({ on: false, work: 25, brk: 5, longBrk: 15, every: 4, auto: true, ...(db.settings.focus || {}) });
function newFocus() { const c = focusCfg(); return { work: c.work, brk: c.brk, longBrk: c.longBrk, every: c.every, auto: c.auto, round: 1, phase: 'read', blockStart: timerMs() }; }
// Time left in the current reading block, or in the break.
function focusLeft() {
  const f = db.timer?.focus;
  if (!f) return 0;
  if (f.phase === 'break') return f.breakEndsAt - Date.now();
  if (f.phase === 'breakover') return 0;
  return f.work * 60000 - (timerMs() - f.blockStart);
}
function notify(title, body) {
  try { navigator.vibrate?.([180, 90, 180]); } catch {}
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try { new Notification(title, { body, icon: 'icons/icon-192.png', silent: true, tag: 'bibliophile-focus' }); } catch {}
  }
}
function focusTick() {
  const t = db.timer, f = t?.focus;
  if (!f) return;
  if (f.phase === 'read' && t.startedAt && focusLeft() <= 0) {
    // Block finished. If the phone was locked past the bell, only count the block itself as reading.
    const over = -focusLeft();
    t.elapsed += Date.now() - t.startedAt - over; t.startedAt = null;
    const long = f.round % f.every === 0;
    f.breakLen = long ? f.longBrk : f.brk;
    f.phase = 'break'; f.breakEndsAt = Date.now() - over + f.breakLen * 60000;
    save({ quiet: true });
    Sound.onTimerPause(); Sound.bell(3);
    notify('Time for a break', `${f.breakLen}-minute ${long ? 'long ' : ''}break — stretch, look away, have some water.`);
    render();
  } else if (f.phase === 'break' && focusLeft() <= 0) {
    Sound.bell(1, 0);
    notify('Break’s over', f.auto ? 'Back to your book.' : 'Start your next block when you’re ready.');
    if (f.auto) startNextBlock();                       // counts the next block
    else { f.round += 1; f.phase = 'breakover'; save({ quiet: true }); render(); }
  }
}
function startNextBlock() {
  const t = db.timer, f = t?.focus;
  if (!f) return;
  if (f.phase === 'break') f.round += 1;      // leaving a break (on time or skipped) starts the next block
  f.phase = 'read'; delete f.breakEndsAt;
  if (!t.startedAt) t.startedAt = Date.now();
  f.blockStart = timerMs();
  save({ quiet: true });
  Sound.onTimerResume();
  render();
}
function focusPanel(t) {
  const c = focusCfg(), f = t?.focus;
  const on = f ? true : c.on;
  const preset = Object.entries(FOCUS_PRESETS).find(([, v]) => v.work === c.work && v.brk === c.brk)?.[0];
  return `
    <section class="focus-card ${on ? 'on' : ''}">
      <div class="focus-head">
        <label class="switch"><input type="checkbox" data-focus="toggle" ${on ? 'checked' : ''}><span></span></label>
        <div><b>Focus blocks</b><small>${on ? `${c.work} min reading · ${c.brk} min breaks · ${c.longBrk} min every ${c.every}` : 'Read in blocks with a bell for short breaks'}</small></div>
      </div>
      ${on ? `
      <div class="chips focus-presets">${Object.keys(FOCUS_PRESETS).map((k) => `<button class="chip sm ${preset === k ? 'on' : ''}" data-action="focus-preset" data-v="${k}">${k.replace('/', ' / ')}</button>`).join('')}
        <button class="chip sm ${preset ? '' : 'on'}" data-action="focus-custom">Custom</button></div>
      ${!preset || ui.focusCustom ? `<div class="focus-custom">
        <label>Read <input type="number" min="5" max="180" data-focus="work" value="${c.work}"> min</label>
        <label>Break <input type="number" min="1" max="60" data-focus="brk" value="${c.brk}"> min</label>
        <label>Long break <input type="number" min="1" max="90" data-focus="longBrk" value="${c.longBrk}"> min every <input type="number" min="2" max="10" data-focus="every" value="${c.every}"> blocks</label>
      </div>` : ''}
      <label class="focus-auto"><input type="checkbox" data-focus="auto" ${c.auto ? 'checked' : ''}> Start the next block by itself after a break</label>` : ''}
    </section>`;
}

function renderTimerBar(route) {
  const bar = $('#timer-bar');
  const t = db.timer;
  const book = t && getBook(t.bookId);
  if (!book || route === 'timer') { bar.hidden = true; return; }
  bar.hidden = false;
  bar.innerHTML = `
    <a href="#/timer" class="tb-main"><span class="tb-dot ${t.startedAt ? 'live' : ''}"></span><span class="tb-title">${t.focus?.phase === 'break' ? 'Break' : esc(book.title)}</span><span class="${t.focus?.phase === 'break' ? 'focus-left' : 'timer-clock'}">${t.focus?.phase === 'break' ? fmtClock(Math.max(0, focusLeft())) : fmtClock(timerMs())}</span></a>
    ${t.focus && t.focus.phase !== 'read' ? '<button class="link-btn" data-action="focus-skip">Keep reading</button>'
      : t.startedAt ? '<button class="link-btn" data-action="timer-pause">Pause</button>' : '<button class="link-btn" data-action="timer-resume">Resume</button>'}
    <button class="link-btn" data-action="timer-stop">Done</button>`;
}

// ============ CHOOSE A COVER ============
function coverPicker(book) {
  if (!book) return;
  const search = encodeURIComponent(`${book.title} ${book.author || ''} book cover`);
  openModal(`
    <h2>Choose a cover</h2>
    <p class="muted small">${esc(book.title)}${book.author ? ` — ${esc(book.author)}` : ''}. Pick one and it's saved in this app, so it works offline.</p>
    <div class="cp-actions">
      <button type="button" class="btn sm" data-action="cp-auto" data-id="${esc(book.id)}">Look for it automatically</button>
      <a class="btn sm ghost" target="_blank" rel="noopener" href="https://www.google.com/search?tbm=isch&q=${search}">Search Google Images ↗</a>
    </div>
    <h3 class="cp-h">Editions on Open Library</h3>
    <div class="cp-grid" id="cp-ol"><p class="muted small">Looking…</p></div>
    <h3 class="cp-h">Google Books</h3>
    <div class="cp-grid" id="cp-gb"><p class="muted small">Looking…</p></div>
    <form class="cp-url" data-form="cover-url">
      <input type="hidden" name="id" value="${esc(book.id)}">
      <label>Or paste a picture's address <input name="url" type="url" placeholder="https://…" required></label>
      <button class="btn sm">Use this picture</button>
    </form>
    <label class="cp-up">Or upload a photo of your copy
      <input type="file" accept="image/*" data-cover-upload="${esc(book.id)}">
    </label>`, (root) => {
    const tile = (url, thumb, label) => `<button type="button" class="cp-opt" data-action="cp-pick" data-id="${esc(book.id)}" data-url="${esc(url)}" title="${esc(label)}">
      <img src="${esc(thumb)}" alt="" loading="lazy" onerror="this.closest('.cp-opt').remove()"><small>${esc(label || 'Cover')}</small></button>`;
    const olBox = $('#cp-ol', root), gbBox = $('#cp-gb', root);
    editionCovers(book).then((list) => {
      olBox.innerHTML = list.length ? list.map((c) => tile(c.large, c.thumb, c.label)).join('') : '<p class="muted small">No other editions found on Open Library.</p>';
    });
    googleCoverOptions(book).then((list) => {
      gbBox.innerHTML = list.length ? list.map((c) => tile(c.url, c.url, c.label)).join('') : '<p class="muted small">Nothing on Google Books for this title.</p>';
    });
  });
}

async function saveChosenCover(book, url) {
  if (!book || !url) return;
  toast('Saving the cover…');
  try {
    await coverFromUrl(book, url);
    closeModal();
    toast('Cover saved');
  } catch {
    toast('That picture couldn’t be used — try another');
  }
}

function viewTimer() {
  const t = db.timer;
  const book = t && getBook(t.bookId);
  if (!book) {
    const reading = db.books.filter((b) => b.status === 'reading');
    const others = db.books.filter((b) => b.status !== 'reading' && b.status !== 'finished').sort((a, b) => a.title.localeCompare(b.title));
    return `
      <header class="page-head"><h1>Reading room</h1></header>
      <p class="lede-sm">Start a timer when you sit down to read. It keeps running if you lock your phone or close the app, and logs the session when you're done.</p>
      ${reading.length ? `<div class="pick-grid">${reading.map((b) => `
        <button class="pick" data-action="timer-start" data-id="${b.id}">${cover(b, 'md')}<span><b>${esc(b.title)}</b><span class="byline">${esc(b.author)}</span><span class="eyebrow">Begin reading →</span></span></button>`).join('')}</div>`
        : '<p class="muted">Nothing marked as currently reading.</p>'}
      ${others.length ? `<p class="small muted">Or start something else:
        <select data-timer-pick class="pick-select">
          <option value="">Choose a book…</option>${others.map((b) => `<option value="${b.id}">${esc(b.title)}</option>`).join('')}
        </select></p>` : ''}
      ${focusPanel(null)}`;
  }
  const running = !!t.startedAt;
  const f = t.focus;
  if (f && (f.phase === 'break' || f.phase === 'breakover')) {
    const over = f.phase === 'breakover';
    return `
    <section class="reading-room on-break">
      <div class="eyebrow center">${over ? 'Break’s over' : `${f.breakLen >= f.longBrk && f.round % f.every === 0 ? 'Long break' : 'Break'} · after block ${f.round}`}</div>
      <div class="break-ring">${cover(book, 'md')}</div>
      <h1>${over ? 'Ready when you are' : 'Rest your eyes'}</h1>
      <p class="byline">${over ? `${esc(book.title)} is waiting.` : 'Stand up, stretch, look at something far away, have some water.'}</p>
      ${over ? '' : `<div class="focus-clock big focus-left">${fmtClock(Math.max(0, focusLeft()))}</div>`}
      <p class="muted small">Read so far: <span class="timer-clock">${fmtClock(timerMs())}</span> · breaks aren’t counted</p>
      <div class="row gap center wrap">
        <button class="btn primary" data-action="focus-skip">${over ? 'Start reading' : 'Skip break — keep reading'}</button>
        <button class="btn" data-action="timer-stop">Finish &amp; log</button>
      </div>
    </section>${focusPanel(t)}`;
  }
  return `
    <section class="reading-room">
      <div class="eyebrow center">${running ? (f ? `Now reading · block ${f.round}` : 'Now reading') : 'Paused'}</div>
      <a href="#/book/${book.id}">${cover(book, 'lg')}</a>
      <h1>${esc(book.title)}</h1>
      <p class="byline">${esc(book.author)}${book.pages ? ` · from p. ${book.currentPage || 0}` : ''}</p>
      <div class="timer-clock big ${running ? '' : 'paused'}">${fmtClock(timerMs())}</div>
      ${f ? `<div class="focus-status"><div class="focus-bar"><span style="width:${Math.min(100, 100 - (focusLeft() / (f.work * 60000)) * 100)}%"></span></div>
        <p class="muted small"><span class="focus-left">${fmtClock(Math.max(0, focusLeft()))}</span> until a ${f.round % f.every === 0 ? f.longBrk : f.brk}-minute ${f.round % f.every === 0 ? 'long ' : ''}break</p></div>` : ''}
      <div class="row gap center wrap">
        ${running ? '<button class="btn" data-action="timer-pause">Pause</button>' : '<button class="btn" data-action="timer-resume">Resume</button>'}
        <button class="btn primary" data-action="timer-stop">Finish &amp; log</button>
      </div>
      <div class="row center gap room-links">
        <button class="link-btn" data-action="add-item" data-book="${book.id}">Save a passage</button>
        <button class="link-btn" data-action="timer-discard">Discard</button>
      </div>
    </section>${focusPanel(t)}`;
}

// Focus settings: remembered for next time, and applied to the session that's running.
function focusSetting(el) {
  const c = focusCfg();
  const k = el.dataset.focus;
  if (k === 'toggle') {
    c.on = el.checked;
    if (c.on && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
    const t = db.timer;
    if (t) {
      if (c.on && !t.focus) { t.focus = newFocus(); if (!t.startedAt) { t.startedAt = Date.now(); t.focus.blockStart = timerMs(); } }
      if (!c.on && t.focus) { const wasBreak = t.focus.phase !== 'read'; delete t.focus; if (wasBreak) { t.startedAt = Date.now(); Sound.onTimerResume(); } }
    }
  } else if (k === 'auto') c.auto = el.checked;
  else {
    const n = Math.round(Number(el.value));
    const lim = { work: [5, 180], brk: [1, 60], longBrk: [1, 90], every: [2, 10] }[k];
    if (!n || !lim) return;
    c[k] = Math.min(lim[1], Math.max(lim[0], n));
  }
  db.settings.focus = c;
  if (db.timer?.focus && k !== 'toggle') { const f = db.timer.focus; f.work = c.work; f.brk = c.brk; f.longBrk = c.longBrk; f.every = c.every; f.auto = c.auto; }
  save();
}

// ============ VOICE DICTATION ============
// Uses the browser's built-in speech recognition (Chrome, Edge, Safari, Android). Free, no key needed.
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
function micButton(target, label = 'Dictate', mode = 'note') {
  if (!SpeechRec) return '';
  return `<button type="button" class="link-btn mic" data-action="dictate" data-target="${target}" data-mode="${mode}"><span class="mic-dot"></span>${label}</button>`;
}
const joinText = (before, added) => before + (before && !/\s$/.test(before) ? ' ' : '') + added;
let lastTidy = null; // so "Undo" can put back exactly what was said

function toggleDictation(btn) {
  if (rec) { rec.stop(); return; }
  const scope = btn.closest('dialog') || document;
  let target = $(btn.dataset.target, scope);
  if (!target) return;
  // The page can redraw while you speak (e.g. a cover finishing downloading): always write into the live box.
  const liveBox = () => (target.isConnected ? target : (target = $(btn.dataset.target, btn.closest('dialog') || document) || target));
  const status = btn.parentElement.querySelector('.interim');
  const label = btn.innerHTML;
  const before = target.value;   // what was already in the box
  let spoken = '';               // only what's said this time gets tidied
  rec = new SpeechRec();
  rec.lang = navigator.language || 'en-US';
  rec.continuous = true;
  rec.interimResults = true;
  rec.onresult = (ev) => {
    let live = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) {
        spoken = joinText(spoken, r[0].transcript.trim());
        liveBox().value = joinText(before, spoken);
        target.dispatchEvent(new Event('input', { bubbles: true })); // keeps the draft current
      }
      else live += r[0].transcript;
    }
    if (status) status.textContent = live;
  };
  rec.onerror = (ev) => { if (ev.error === 'not-allowed') toast('Microphone permission was blocked'); };
  rec.onend = () => {
    rec = null; btn.classList.remove('on'); btn.innerHTML = label;
    if (status) status.textContent = '';
    liveBox().dispatchEvent(new Event('input', { bubbles: true }));
    const liveStatus = status?.isConnected ? status : target.closest('form, .review-box')?.querySelector('.interim') || status;
    if (spoken.trim() && db.settings.autoTidy !== false) tidyAfterDictation(target, before, spoken, btn.dataset.mode || 'note', liveStatus);
  };
  rec.start();
  btn.classList.add('on');
  btn.innerHTML = '<span class="mic-dot"></span>Listening… tap to stop';
}

async function tidyAfterDictation(target, before, spoken, mode, status) {
  const targetId = target.id, targetName = target.name;
  const form = target.closest('form');
  const bookId = form?.bookId?.value || target.dataset.book || '';
  const bookTitle = getBook(bookId)?.title || '';
  if (status) status.textContent = mode === 'passage' ? 'Adding punctuation…' : 'Tidying…';
  const { text, via, reason } = await tidyDictation(spoken, mode, bookTitle);
  // If the page was redrawn meanwhile, the box is a new element — find it again.
  if (!target.isConnected) target = (targetId && document.getElementById(targetId)) || (targetName && $(`dialog [name="${targetName}"]`)) || target;
  if (status && !status.isConnected) status = target.closest('form, .review-box')?.querySelector('.interim') || null;
  // If you kept typing meanwhile, don't overwrite anything.
  if (target.value !== joinText(before, spoken) || !text) { if (status) status.textContent = ''; return; }
  target.value = joinText(before, text);
  target.dispatchEvent(new Event('input', { bubbles: true }));
  if (target.tagName === 'TEXTAREA') target.rows = Math.min(12, Math.max(target.rows, target.value.split('\n').length + 1, Math.ceil(target.value.length / 70) + 1));
  lastTidy = { target, before, spoken, text };
  const how = via === 'ai' ? 'Tidied with AI' : via === 'device' ? 'Tidied on this device' : mode === 'passage' ? 'Punctuation added' : 'Basic tidy';
  if (status) status.innerHTML = `<span class="tidy-done">✓ ${how}</span> <button type="button" class="link-btn" data-action="undo-tidy">Undo</button>${reason && via !== 'ai' ? ` <span class="ai-why" title="${esc(reason)}">· AI not used: ${esc(reason.split(/(?<=\.)\s/)[0])}</span>` : ''}${via === 'basic' && !hasAI() && mode !== 'passage' && !target.closest('dialog') ? ' <a href="#/settings" class="small">Better tidying →</a>' : ''}`;
}

// ============ TIDY A REVIEW ============
async function tidyFlow(book, btn) {
  const original = $('#review-text').value.trim();
  if (!original) { toast('Write or speak a review first'); return; }
  let tidied, viaAI = hasAI();
  if (viaAI) {
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Tidying…';
    try { tidied = await tidyReview(original, book); }
    catch (err) { toast(`${err.message} — did a basic tidy instead`); viaAI = false; }
    btn.disabled = false; btn.textContent = label;
  }
  if (!tidied) tidied = tidyLocally(original);
  openModal(`
    <h2>Tidied review</h2>
    <p class="muted small">${viaAI ? 'Edited by AI from your words. Change anything before using it.' : 'Basic clean-up: filler words removed, sentences capitalised. Add a free AI key in Settings for a proper edit.'}</p>
    <div class="compare">
      <div><div class="eyebrow">Your words</div><div class="compare-orig">${nl2br(original)}</div></div>
      <div><div class="eyebrow">Tidied</div><textarea id="tidied" rows="10">${esc(tidied)}</textarea></div>
    </div>
    <div class="row gap end">
      <button class="btn ghost" data-action="close">Keep mine</button>
      <button class="btn primary" id="use-tidied">Use tidied version</button>
    </div>`, (root) => {
    $('#use-tidied', root).onclick = () => {
      book.review = $('#tidied', root).value.trim();
      book.reviewUpdatedAt = new Date().toISOString();
      setReviewDraft(book.id, null);
      closeModal(); save(); toast('Review updated');
    };
  });
}

// ============ CAPTION / REEL SCRIPT ============
function socialModal(book) {
  const quotes = itemsForBook(book.id).filter((i) => i.kind !== 'word').length;
  const drafts = { caption: captionTemplate(book), reel: reelTemplate(book) };
  let tab = 'caption';
  openModal(`
    <h2>Create a post</h2>
    <p class="muted small">From ${plural(quotes, 'saved passage')}${book.review ? ', your review' : ''}${book.rating ? ' and your rating' : ''}. ${quotes ? '' : 'Save a few quotes first for a better result.'}</p>
    <div class="chips social-tabs">
      <button class="chip on" data-tab="caption">Caption</button>
      <button class="chip" data-tab="reel">Reel script</button>
    </div>
    <textarea id="social-text" rows="14"></textarea>
    <div class="row gap between wrap">
      ${hasAI() ? '<button class="btn" id="social-ai">✦ Write with AI</button>' : '<span class="muted small">Templates are free and offline. <a href="#/settings" data-action="close">Add an AI key</a> for richer drafts.</span>'}
      <div class="row gap">
        <button class="btn ghost" id="social-reset">Reset</button>
        <button class="btn primary" id="social-copy">Copy</button>
      </div>
    </div>`, (root) => {
    const ta = $('#social-text', root);
    const show = () => { ta.value = drafts[tab]; };
    show();
    ta.addEventListener('input', () => { drafts[tab] = ta.value; });
    $$('[data-tab]', root).forEach((b) => b.addEventListener('click', () => {
      tab = b.dataset.tab;
      $$('[data-tab]', root).forEach((x) => x.classList.toggle('on', x === b));
      show();
    }));
    $('#social-reset', root).onclick = () => { drafts[tab] = tab === 'caption' ? captionTemplate(book) : reelTemplate(book); show(); };
    $('#social-copy', root).onclick = async () => { await navigator.clipboard?.writeText(ta.value).catch(() => {}); toast('Copied — paste it into Instagram, TikTok or Threads'); };
    const ai = $('#social-ai', root);
    if (ai) ai.onclick = async () => {
      ai.disabled = true; ai.textContent = 'Writing…';
      try { drafts[tab] = await (tab === 'caption' ? aiCaption(book) : aiReel(book)); show(); }
      catch (err) { alert('AI request failed: ' + err.message); }
      ai.disabled = false; ai.textContent = '✦ Write with AI';
    };
  });
}

// ============ YEAR IN BOOKS IMAGE ============
async function yearModal() {
  const years = yearsWithReading();
  let year = years[0], theme = db.settings.theme === 'dark' ? 'night' : 'ivory', blob = null;
  const names = { ivory: 'Soft Ivory', night: 'Night Reading', oxblood: 'Oxblood' };
  openModal(`
    <h2>Your year in books</h2>
    <div class="row gap wrap between center-v year-controls">
      <select id="yc-year">${years.map((y) => `<option>${y}</option>`).join('')}</select>
      <div class="chips">${YEAR_THEMES.map((t) => `<button class="chip ${t === theme ? 'on' : ''}" data-yt="${t}">${names[t]}</button>`).join('')}</div>
    </div>
    <div class="year-preview"><p class="muted">Composing…</p></div>
    <div class="row gap end">
      ${navigator.canShare ? '<button class="btn" id="yc-share">Share…</button>' : ''}
      <button class="btn primary" id="yc-dl">Download</button>
    </div>`, (root) => {
    const preview = $('.year-preview', root);
    const draw = async () => {
      preview.innerHTML = '<p class="muted">Composing…</p>';
      blob = await yearCard(year, theme);
      preview.innerHTML = `<img src="${URL.createObjectURL(blob)}" alt="My ${year} in books">`;
    };
    $('#yc-year', root).onchange = (e) => { year = e.target.value; draw(); };
    $$('[data-yt]', root).forEach((b) => b.addEventListener('click', () => {
      theme = b.dataset.yt; $$('[data-yt]', root).forEach((x) => x.classList.toggle('on', x === b)); draw();
    }));
    $('#yc-dl', root).onclick = () => blob && download(`my-${year}-in-books.png`, blob);
    const sh = $('#yc-share', root);
    if (sh) sh.onclick = async () => {
      if (!blob) return;
      const file = new File([blob], `my-${year}-in-books.png`, { type: 'image/png' });
      try { if (navigator.canShare({ files: [file] })) await navigator.share({ files: [file], title: `My ${year} in books` }); else download(file.name, blob); } catch {}
    };
    draw();
  });
}

// ============ FOR YOU (recommendations) ============
// Everything is worked out on this device from your own library; the only thing sent anywhere is
// book searches to Open Library. No AI, no key, no limits.
Object.assign(ui, { recFilter: 'all', recData: null, recLoading: false, recProgress: '', recError: '', recAsk: {}, recRemoved: {}, recAdded: {}, recOpen: new Set() });

function startRecs(force = false) {
  if (ui.recLoading) return;
  ui.recLoading = true; ui.recError = ''; ui.recProgress = 'Starting…';
  if (force) ui.recData = null;
  if (location.hash.startsWith('#/foryou')) render();
  Recs.buildRecommendations((msg) => {
    ui.recProgress = msg;
    const el = $('.rec-progress'); if (el) el.textContent = msg;
  }).then((d) => { ui.recData = d; ui.recRemoved = {}; ui.recAsk = {}; })
    .catch((e) => { ui.recError = e.message || 'Something went wrong'; })
    .finally(() => { ui.recLoading = false; if (location.hash.startsWith('#/foryou') || location.hash === '#/' || location.hash === '') render(); });
}
const recCard = (key) => { for (const s of ui.recData?.sections || []) { const c = s.items.find((x) => x.key === key); if (c) return c; } return null; };
const recCover = (c) => {
  const byId = c.cover ? `https://covers.openlibrary.org/b/id/${c.cover}-M.jpg` : '';
  const english = c.enIsbn ? `https://covers.openlibrary.org/b/isbn/${c.enIsbn}-M.jpg?default=false` : '';
  return { id: 'rec:' + c.key, title: c.title, author: c.author, cover: english || byId, coverAlt: english && byId ? [byId] : [] };
};
const recFilterOk = (c) => ui.recFilter === 'all' || (ui.recFilter === 'fiction' && c.fiction) || (ui.recFilter === 'nonfiction' && !c.fiction) || (ui.recFilter === 'short' && c.pages && c.pages < 300);

function viewForYou() {
  if (!ui.recData) ui.recData = Recs.cached();
  const data = ui.recData;
  if (!ui.recLoading && !ui.recError && Recs.isStale(data)) setTimeout(() => startRecs(), 0);
  const head = `
    <header class="page-head">
      <div>
        <div class="eyebrow">Picked for you</div>
        <h1>Recommendations</h1>
      </div>
      <button class="btn" data-action="rec-refresh" ${ui.recLoading ? 'disabled' : ''}>${ui.recLoading ? 'Updating…' : 'Refresh'}</button>
    </header>
    <p class="lede-sm">Picked from your ratings, what you finished or abandoned, and the themes in your reviews and notes — matched against how books are described and shelved by other readers on Open Library. It's free and works it out on this device; the more you rate and write, the better it gets.</p>`;
  if (!db.books.length) return head + `<p class="empty">Add and rate a few books you've read — recommendations start from what you love.</p>`;
  if (ui.recError && !data) return head + `<p class="empty">Couldn't reach Open Library (${esc(ui.recError)}). <a href="#" data-action="rec-refresh">Try again</a></p>`;
  if (!data || (ui.recLoading && !data.sections?.length)) {
    return head + `<div class="rec-loading"><div class="ornament">❦</div><p class="rec-progress">${esc(ui.recProgress || 'Reading your library…')}</p><p class="muted small">The first time takes a little longer — it looks up the subjects of each of your books once.</p></div>`;
  }
  if (!data.sections.length) {
    return head + `<p class="empty">${data.ratedCount < 2 ? 'Rate a few books you’ve finished — especially ones you loved — and come back.' : 'No good matches yet. Try rating a few more books or writing a line or two of review.'}</p>`;
  }
  const filters = { all: 'All', fiction: 'Fiction', nonfiction: 'Non-fiction', short: 'Under 300 pages' };
  return head + `
    <div class="chips rec-filters">${Object.entries(filters).map(([k, v]) => `<button class="chip ${ui.recFilter === k ? 'on' : ''}" data-action="rec-filter" data-value="${k}">${v}</button>`).join('')}</div>
    ${ui.recLoading ? `<p class="muted small rec-progress">${esc(ui.recProgress)}</p>` : ''}
    ${data.sections.map((s) => {
      const items = s.items.filter(recFilterOk);
      if (!items.length) return '';
      return `<section class="section rec-section">
        <div class="section-head"><h2>${esc(s.title)}</h2></div>
        <div class="rec-grid">${items.map(recCardHTML).join('')}</div>
      </section>`;
    }).join('')}
    <p class="muted small rec-foot">Updated ${new Date(data.at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })} · refreshes daily and whenever your library changes · book data from <a href="https://openlibrary.org" target="_blank" rel="noopener">Open Library</a></p>`;
}

function recCardHTML(c) {
  const removed = ui.recRemoved[c.key];
  if (removed) {
    return `<article class="rec-card removed"><p>Removed <i>${esc(c.title)}</i>${removed === 'genre' || removed === 'similar' ? ' — you’ll see fewer like it' : removed === 'long' ? ' — you’ll see fewer long books' : ''}.</p><button class="link-btn" data-action="rec-undo" data-key="${esc(c.key)}">Undo</button></article>`;
  }
  const added = ui.recAdded[c.key];
  const book = added && getBook(added.id);
  const meta = [c.year, c.pages ? `${c.pages} pages` : ''].filter(Boolean).join(' · ');
  let actions;
  if (book && added.status === 'want') actions = `<p class="rec-state">✓ On your Want to read shelf · <a href="#/book/${book.id}">Open</a></p>`;
  else if (book) actions = `<div class="rec-state">Added to your library. How was it? ${stars(book.rating, book.id)}</div>`;
  else if (ui.recAsk[c.key]) {
    actions = `<div class="rec-why-not"><span class="muted small">What’s off?</span>
      ${[['genre', 'Not my kind of book'], ['similar', 'Read enough like it'], ['long', 'Too long'], ['meh', 'Just not interested']].map(([k, v]) => `<button class="chip sm" data-action="rec-dismiss" data-key="${esc(c.key)}" data-reason="${k}">${v}</button>`).join('')}
      <button class="link-btn" data-action="rec-cancel" data-key="${esc(c.key)}">Cancel</button></div>`;
  } else {
    actions = `<div class="rec-actions">
      <button class="btn sm primary" data-action="rec-want" data-key="${esc(c.key)}">Want to read</button>
      <button class="btn sm" data-action="rec-read" data-key="${esc(c.key)}">Already read</button>
      <button class="link-btn" data-action="rec-no" data-key="${esc(c.key)}">Not for me</button></div>`;
  }
  return `<article class="rec-card">
    <a href="https://openlibrary.org${esc(c.key)}" target="_blank" rel="noopener" class="rec-cover">${cover(recCover(c), 'md')}</a>
    <div class="rec-body">
      <h3>${esc(c.title)}</h3>
      <p class="byline">${esc(c.author)}${meta ? ` <span class="muted small">· ${meta}</span>` : ''}</p>
      <p class="rec-reason">${esc(c.reason)}</p>
      ${c.readers ? `<p class="muted small rec-readers">${esc(c.readers)}</p>` : ''}
      ${(() => { const open = ui.recOpen.has(c.key); const d = Recs.describedAlready(c.key); return `<details class="rec-about" data-key="${esc(c.key)}" ${open ? 'open' : ''} ${d != null ? 'data-loaded="1"' : ''}><summary>About this book</summary><div class="rec-desc muted">${d == null ? 'Loading…' : d ? nl2br(d.length > 900 ? d.slice(0, 900).replace(/\s+\S*$/, '') + '…' : d) : 'No description on Open Library.'}</div>`; })()}${c.tags?.length ? `<p class="rec-tags">${c.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join(' ')}</p>` : ''}</details>
      ${actions}
    </div>
  </article>`;
}

function homePicks() {
  const data = ui.recData || Recs.cached();
  const first = data?.sections?.[0];
  if (!first?.items?.length) return '';
  const picks = first.items.filter((c) => !ui.recRemoved[c.key] && !ui.recAdded[c.key]).slice(0, 5);
  if (!picks.length) return '';
  return `<section class="section">
    <div class="section-head"><h2>Recommended for you</h2><a href="#/foryou" class="more">All recommendations →</a></div>
    <div class="pick-row">${picks.map((c) => `<a href="#/foryou" class="pick-mini" title="${esc(c.reason)}">${cover(recCover(c))}<span class="shelf-title">${esc(c.title)}</span><span class="muted small">${esc(c.author)}</span></a>`).join('')}</div>
  </section>`;
}

// Load a book's description the first time its "About this book" is opened.
document.addEventListener('toggle', async (e) => {
  const d = e.target;
  if (!d.matches?.('.rec-about')) return;
  d.open ? ui.recOpen.add(d.dataset.key) : ui.recOpen.delete(d.dataset.key);
  if (!d.open || d.dataset.loaded) return;
  d.dataset.loaded = '1';
  const text = await Recs.describe(d.dataset.key);
  const box = (d.isConnected ? d : document.querySelector(`.rec-about[data-key="${CSS.escape(d.dataset.key)}"]`))?.querySelector('.rec-desc');
  if (box) box.innerHTML = text ? nl2br(text.length > 900 ? text.slice(0, 900).replace(/\s+\S*$/, '') + '…' : text) : 'No description on Open Library.';
}, true);

// ============ FORMS ============

function bookForm(book = {}, opts = {}) {
  const isNew = !book.id;
  openModal(`
    <h2>${isNew ? 'Add a book' : 'Edit book'}</h2>
    ${isNew ? `
      <div class="lookup">
        <input type="search" id="ol-q" placeholder="Search by title, author or ISBN to auto-fill…" autofocus>
        <div id="ol-results" class="ol-results"></div>
      </div>` : ''}
    <form class="form" data-form="book">
      <input type="hidden" name="id" value="${esc(book.id || '')}">
      <div class="row gap">
        <div id="form-cover">${cover({ id: book.id, title: book.title || '', author: book.author || '', cover: book.cover }, 'sm')}</div>
        <div class="grow col gap-sm">
          <label>Title <input name="title" required value="${esc(book.title || '')}" ${isNew ? '' : 'autofocus'}></label>
          <label>Author <input name="author" value="${esc(book.author || '')}"></label>
        </div>
      </div>
      <div class="row gap">
        <label class="grow">Status
          <select name="status">${Object.entries(STATUSES).map(([k, v]) => `<option value="${k}" ${(book.status || 'reading') === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        </label>
        <label class="grow">Format
          <select name="format">${['print', 'ebook', 'audiobook'].map((f) => `<option ${book.format === f ? 'selected' : ''}>${f}</option>`).join('')}</select>
        </label>
      </div>
      <div class="row gap">
        <label class="grow">Pages <input name="pages" type="number" min="0" value="${book.pages || ''}"></label>
        <label class="grow">Published <input name="year" value="${esc(book.year || '')}"></label>
        <label class="grow">ISBN <input name="isbn" value="${esc(book.isbn || '')}"></label>
      </div>
      <div class="row gap">
        <label class="grow">Started <input name="startedAt" type="date" value="${esc(book.startedAt || '')}"></label>
        <label class="grow">Finished <input name="finishedAt" type="date" value="${esc(book.finishedAt || '')}"></label>
      </div>
      <label>Tags <input name="tags" value="${esc((book.tags || []).join(', '))}" placeholder="fiction, philosophy, book-club"></label>
      <div class="row gap">
        <label class="grow">Cover image URL <input name="cover" value="${esc(book.cover || '')}" placeholder="filled in automatically"></label>
        <label class="grow">Or a photo of your copy <input name="coverFile" type="file" accept="image/*"></label>
      </div>
      <p class="muted small form-hint">Leave both empty and the cover is found for you (Open Library, then Google Books).</p>
      <div class="row gap end">
        <button type="button" class="btn ghost" data-action="close">Cancel</button>
        <button class="btn primary">${isNew ? 'Add book' : 'Save'}</button>
      </div>
    </form>`, (root) => {
    const fileInput = $('[name=coverFile]', root);
    fileInput?.addEventListener('change', () => {
      const f = fileInput.files?.[0];
      if (f) $('#form-cover', root).innerHTML = `<div class="cover sm"><img src="${URL.createObjectURL(f)}" alt=""></div>`;
    });
    const q = $('#ol-q', root);
    if (!q) return;
    let timer, ctl;
    q.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const term = q.value.trim();
        const out = $('#ol-results', root);
        if (term.length < 3) { out.innerHTML = ''; return; }
        out.innerHTML = '<p class="muted small">Searching Open Library…</p>';
        ctl?.abort(); ctl = new AbortController();
        try {
          const isIsbn = /^[\d-]{10,17}x?$/i.test(term);
          const url = `https://openlibrary.org/search.json?${isIsbn ? 'isbn' : 'q'}=${encodeURIComponent(term)}&limit=8&fields=title,author_name,cover_i,number_of_pages_median,first_publish_year,isbn`;
          const res = await fetch(url, { signal: ctl.signal });
          const data = await res.json();
          if (!data.docs?.length) { out.innerHTML = '<p class="muted small">No matches — just fill in the details below.</p>'; return; }
          out.innerHTML = data.docs.map((d, i) => `
            <button type="button" class="ol-hit" data-i="${i}">
              ${d.cover_i ? `<img src="https://covers.openlibrary.org/b/id/${d.cover_i}-S.jpg" alt="">` : '<span class="ol-nocover"></span>'}
              <span><b>${esc(d.title)}</b><br><span class="muted small">${esc((d.author_name || []).join(', '))}${d.first_publish_year ? ' · ' + d.first_publish_year : ''}</span></span>
            </button>`).join('');
          $$('.ol-hit', out).forEach((btn) => btn.addEventListener('click', () => {
            const d = data.docs[btn.dataset.i];
            const f = $('form', root);
            f.title.value = d.title || '';
            f.author.value = (d.author_name || []).slice(0, 2).join(' & ');
            f.pages.value = d.number_of_pages_median || '';
            f.year.value = d.first_publish_year || '';
            f.isbn.value = (d.isbn || []).find((x) => x.length === 13) || (d.isbn || [])[0] || '';
            f.cover.value = d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : '';
            $('#form-cover', root).innerHTML = cover({ title: f.title.value, author: f.author.value, cover: f.cover.value }, 'sm');
            out.innerHTML = '';
            q.value = '';
          }));
        } catch (e) {
          if (e.name !== 'AbortError') out.innerHTML = '<p class="muted small">Couldn\'t reach Open Library (offline?). Fill in manually.</p>';
        }
      }, 350);
    });
  }, book.id ? {} : { draft: 'book', restore: opts.restore !== false });
}

function itemForm(item = {}, presetBook = '', opts = {}) {
  const isNew = !item.id;
  const bookId = item.bookId ?? presetBook;
  const books = db.books.slice().sort((a, b) => (b.status === 'reading') - (a.status === 'reading') || a.title.localeCompare(b.title));
  const kind = item.kind || 'highlight';
  const isWord = kind === 'word';
  const heading = (k, isNewItem) => (isNewItem ? (k === 'word' ? 'Save a word' : 'Save a passage') : 'Edit');
  openModal(`
    <h2 class="item-heading">${heading(kind, isNew)}</h2>
    <form class="form" data-form="item">
      <input type="hidden" name="id" value="${esc(item.id || '')}">
      <div class="kind-picker">
        ${Object.entries(KINDS).map(([k, v]) => `<label><input type="radio" name="kind" value="${k}" ${kind === k ? 'checked' : ''}><span>${v.label}</span></label>`).join('')}
      </div>

      <div class="passage-fields" ${isWord ? 'hidden' : ''}>
        <label>Text
          <textarea name="text" rows="5" ${isWord ? '' : 'required autofocus'} placeholder="Type, paste or dictate the passage…">${esc(isWord ? '' : item.text || '')}</textarea>
        </label>
        ${SpeechRec ? `<div class="voice-row">${micButton('[name=text]', 'Read a passage aloud', 'passage')}${micButton('[name=note]', 'Dictate note', 'note')}<span class="interim muted"></span></div>` : ''}
        <label>My note (optional)
          <textarea name="note" rows="2" placeholder="Why it mattered, what it reminds you of…">${esc(isWord ? '' : item.note || '')}</textarea>
        </label>
      </div>

      <div class="word-fields" ${isWord ? '' : 'hidden'}>
        <label>Word
          <div class="row gap center-v">
            <input name="word" class="word-input" ${isWord ? 'required autofocus' : ''} autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(isWord ? item.text || '' : '')}" placeholder="e.g. dereliction">
            <button type="button" class="btn sm" data-action="lookup-word">Look up</button>
          </div>
        </label>
        <label>Meaning
          <textarea name="meaning" rows="3" placeholder="In your own words, or tap Look up">${esc(isWord ? item.note || '' : '')}</textarea>
        </label>
        <label><span>The sentence you found it in <span class="optional">optional</span></span>
          <textarea name="context" rows="3" placeholder="Copy the line from the book — seeing the word in use helps it stick">${esc(item.context || '')}</textarea>
        </label>
        ${SpeechRec ? `<div class="voice-row">${micButton('[name=context]', 'Read the sentence aloud', 'passage')}<span class="interim muted"></span></div>` : ''}
      </div>

      <div class="row gap">
        <label class="grow">From book
          <select name="bookId">
            <option value="">— Not a book (article, film, person…) —</option>
            ${books.map((b) => `<option value="${b.id}" ${bookId === b.id ? 'selected' : ''}>${esc(b.title)}${b.author ? ' — ' + esc(b.author) : ''}</option>`).join('')}
          </select>
        </label>
      </div>
      <label class="source-field" ${bookId ? 'hidden' : ''}>Source <input name="source" value="${esc(item.source || '')}" placeholder="e.g. Seneca, a podcast, a friend"></label>
      <div class="row gap">
        <label class="grow">Page / location <input name="page" value="${esc(item.page || '')}"></label>
        <label class="grow">Chapter <input name="chapter" value="${esc(item.chapter || '')}"></label>
      </div>
      <label>Tags <input name="tags" value="${esc((item.tags || []).join(', '))}" placeholder="love, stoicism, to-share" list="tag-list"></label>
      <datalist id="tag-list">${allTags().map(([t]) => `<option value="${esc(t)}">`).join('')}</datalist>
      <label class="check"><input type="checkbox" name="favorite" ${item.favorite ? 'checked' : ''}> ♥ Favourite</label>
      <div class="row gap end">
        <button type="button" class="btn ghost" data-action="close">Cancel</button>
        ${isNew ? '<button class="btn" name="again" value="1">Save & add another</button>' : ''}
        <button class="btn primary">Save</button>
      </div>
    </form>`, (root) => {
    const f = $('form', root);
    f.bookId.addEventListener('change', () => { $('.source-field', root).hidden = !!f.bookId.value; });
    // Switching between "Word" and the passage types swaps the fields (and what's required).
    $$('input[name=kind]', root).forEach((r) => r.addEventListener('change', () => {
      const w = f.kind.value === 'word';
      $('.passage-fields', root).hidden = w;
      $('.word-fields', root).hidden = !w;
      f.text.required = !w; f.word.required = w;
      $('.item-heading', root).textContent = heading(f.kind.value, isNew);
      // carry what was typed across, so switching doesn't lose it
      if (w && !f.word.value && f.text.value.trim() && !/\s/.test(f.text.value.trim())) { f.word.value = f.text.value.trim(); f.text.value = ''; }
      else if (w && !f.context.value && /\s/.test(f.text.value.trim())) { f.context.value = f.text.value.trim(); f.text.value = ''; }
      (w ? f.word : f.text).focus();
    }));
  }, isNew ? { draft: 'item', restore: opts.restore !== false && !item.text && !item.context } : {});
}

// Free dictionary (dictionaryapi.dev, English). Fills the meaning field; you can edit it.
async function lookupWord(btn) {
  const f = btn.closest('form');
  const word = f.word.value.trim().toLowerCase();
  if (!word) { toast('Type the word first'); f.word.focus(); return; }
  btn.disabled = true; btn.textContent = 'Looking…';
  try {
    const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
    if (res.status === 404) { toast(`No dictionary entry for “${word}” — add the meaning yourself`); return; }
    if (!res.ok) throw new Error(res.status);
    const entries = await res.json();
    const lines = [];
    for (const e of entries) for (const m of e.meanings || []) {
      const d = m.definitions?.[0]?.definition;
      if (d && lines.length < 3 && !lines.some((l) => l.endsWith(d))) lines.push(`(${m.partOfSpeech}) ${d}`);
    }
    if (!lines.length) { toast('No definition found'); return; }
    f.meaning.value = lines.join('\n');
  } catch {
    toast('Dictionary unavailable right now — add the meaning yourself');
  } finally {
    btn.disabled = false; btn.textContent = 'Look up';
  }
}

// Show a sentence with the saved word picked out (matches "abandon" in "abandoned" too).
function contextWithWord(context, word) {
  const html = nl2br(context);
  const stem = word.trim().toLowerCase().replace(/(ing|ed|es|s|ly)$/, '');
  if (stem.length < 3) return html;
  const re = new RegExp(`\\b(${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\w’']*)`, 'gi');
  return html.replace(re, '<mark>$1</mark>');
}

function sessionForm(book, prefill = {}) {
  openModal(`
    <h2>Log reading</h2>
    <p class="muted">${esc(book.title)} — currently on page ${book.currentPage || 0}${book.pages ? ` of ${book.pages}` : ''}${prefill.minutes ? `. You read for <b>${plural(prefill.minutes, 'minute')}</b> — which page did you reach?` : ''}</p>
    <form class="form" data-form="session">
      <input type="hidden" name="id" value="${book.id}">
      <div class="row gap">
        <label class="grow">Now on page <input name="toPage" type="number" min="0" ${book.pages ? `max="${book.pages}"` : ''} required autofocus value=""></label>
        <label class="grow">Minutes <input name="minutes" type="number" min="0" placeholder="optional" value="${prefill.minutes || ''}"></label>
        <label class="grow">Date <input name="date" type="date" value="${today()}"></label>
      </div>
      ${book.pages ? `<button type="button" class="btn sm ghost" data-action="finish-now">I finished it!</button>` : ''}
      <div class="row gap end">
        <button type="button" class="btn ghost" data-action="close">Cancel</button>
        <button class="btn primary">Log</button>
      </div>
    </form>`, (root) => {
    const btn = $('[data-action=finish-now]', root);
    btn && btn.addEventListener('click', (e) => { e.stopPropagation(); $('form', root).toPage.value = book.pages; });
  });
}

async function showCard(item, theme = 0) {
  const blob = await quoteCard(item, theme);
  const url = URL.createObjectURL(blob);
  openModal(`
    <h2>Share as image</h2>
    <img src="${url}" class="card-preview" alt="Quote card">
    <div class="row gap between">
      <button class="btn ghost" data-action="card-theme" data-id="${item.id}" data-theme="${theme + 1}">Change style</button>
      <div class="row gap">
        ${navigator.canShare ? '<button class="btn" id="share-native">Share…</button>' : ''}
        <button class="btn primary" id="dl-card">Download</button>
      </div>
    </div>`, (root) => {
    $('#dl-card', root).onclick = () => download('quote.png', blob);
    const s = $('#share-native', root);
    if (s) s.onclick = async () => {
      const file = new File([blob], 'quote.png', { type: 'image/png' });
      try { if (navigator.canShare({ files: [file] })) await navigator.share({ files: [file] }); else download('quote.png', blob); } catch {}
    };
  });
}

// ============ EVENTS ============

document.addEventListener('mousedown', () => { ui.lastSelection = String(window.getSelection?.() || ''); }, true);
document.addEventListener('touchstart', () => { ui.lastSelection = String(window.getSelection?.() || ''); }, { capture: true, passive: true });

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  const id = el.dataset.id;
  if (el.tagName === 'A' || el.tagName === 'BUTTON') e.preventDefault();

  switch (a) {
    case 'close': requestClose(); break;
    case 'discard-draft': { const k = modalDraft; clearDraft(k); if (k === 'item') itemForm({}, '', { restore: false }); else if (k === 'book') bookForm({}, { restore: false }); break; }
    case 'add-book': bookForm(); break;
    case 'edit-book': bookForm(getBook(id)); break;
    case 'add-item': itemForm({}, el.dataset.book || ''); break;
    case 'edit-item': itemForm(getItem(id)); break;
    case 'log-session': sessionForm(getBook(id)); break;
    case 'delete-book':
      if (confirm(`Delete this book and its ${itemsForBook(id).length} highlights? This can't be undone.`)) { deleteBook(id); removeCover(id); location.hash = '#/library'; toast('Book deleted'); }
      break;
    case 'delete-item':
      if (confirm('Delete this passage?')) { deleteItem(id); toast('Deleted'); }
      break;
    case 'delete-session': {
      const b = getBook(id);
      b.sessions = b.sessions.filter((s) => s.id !== el.dataset.session);
      b.currentPage = b.sessions.reduce((m, s) => Math.max(m, s.toPage), 0);
      save();
      break;
    }
    case 'fav': { const i = getItem(id); i.favorite = !i.favorite; save(); break; }
    case 'copy': {
      const i = getItem(id); const b = getBook(i.bookId);
      const text = `“${i.text}”\n— ${b ? b.title + (b.author ? ', ' + b.author : '') : i.source || ''}`;
      await navigator.clipboard?.writeText(text).catch(() => {});
      toast('Copied to clipboard');
      break;
    }
    case 'card': showCard(getItem(id)); break;
    case 'card-theme': showCard(getItem(id), Number(el.dataset.theme)); break;
    case 'rate': {
      const b = getBook(id); const v = Number(el.dataset.value);
      b.rating = b.rating === v ? 0 : v; // clicking the same value again clears it
      b.ratingFromAspects = false; // a manual rating stops auto-syncing from the breakdown
      save();
      break;
    }
    case 'aspect': {
      const b = getBook(id); const k = el.dataset.aspect; const v = Number(el.dataset.value);
      b.aspects = b.aspects || {};
      b.aspects[k] = b.aspects[k] === v ? 0 : v;
      // If you haven't set an overall rating yourself, keep it in sync with the breakdown.
      if (!b.rating || b.ratingFromAspects) { b.rating = suggestedRating(b.aspects); b.ratingFromAspects = true; }
      save();
      break;
    }
    case 'use-suggested': {
      const b = getBook(id); b.rating = suggestedRating(b.aspects); b.ratingFromAspects = true; save();
      break;
    }
    case 'discard-review': setReviewDraft(id, null); render(); break;
    case 'save-review': {
      const b = getBook(id);
      b.review = $('#review-text').value.trim();
      b.reviewUpdatedAt = new Date().toISOString();
      setReviewDraft(b.id, null);
      save(); toast('Review saved');
      break;
    }
    case 'prompt': {
      const ta = $('#review-text');
      ta.value = (ta.value.trim() ? ta.value.trimEnd() + '\n\n' : '') + el.dataset.text;
      ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      break;
    }
    case 'export-book': { const b = getBook(id); download(`${b.title.replace(/[^\w ]+/g, '').trim() || 'book'}.md`, bookMarkdown(b)); break; }
    case 'export-json': {
      const data = JSON.parse(exportJSON());
      data.coverImages = await exportCovers();
      download(`bibliophile-backup-${today()}.json`, JSON.stringify(data), 'application/json');
      db.lastBackup = new Date().toISOString(); save();
      break;
    }
    case 'change-cover': coverPicker(getBook(id)); break;
    case 'cp-pick': saveChosenCover(getBook(id), el.dataset.url); break;
    case 'cp-auto': {
      const b = getBook(id);
      ensureCover(b, { force: true }).then((r) => { closeModal(); toast(r === 'none' ? 'No cover found automatically — try the options' : 'Cover saved'); });
      break;
    }
    case 'find-cover': {
      const b = getBook(id);
      el.disabled = true; el.textContent = 'Looking…';
      const r = await ensureCover(b, { force: true });
      if (r === 'none') { toast('No cover found — you can upload a photo via Edit'); el.disabled = false; el.textContent = 'Find the cover'; }
      else toast(r === 'found' ? 'Found the cover on Google Books' : 'Cover saved');
      break;
    }
    case 'save-all-covers': {
      el.disabled = true;
      const r = await ensureAll(db.books, (i, n) => { el.textContent = `Working… ${i} of ${n}`; });
      el.disabled = false; el.textContent = 'Save all covers';
      toast(r.checked ? `Saved ${r.saved + r.found} covers${r.found ? ` (${r.found} from Google Books)` : ''}${r.none ? ` · ${r.none} not found` : ''}` : 'Every book already has its cover saved');
      render();
      break;
    }
    case 'clubs-retry': for (const k of Object.keys(clubFetch)) refetch(k); render(); break;
    case 'cloud-open-from-club': e.preventDefault(); ui.cloudOpen = true; location.hash = '#/settings'; await loadCloud(); Cloud.loadProviders(); render(); break;
    case 'club-signin-to-join':
      localStorage.setItem('bibliophile:pending-join', el.dataset.code);
      ui.cloudOpen = true; location.hash = '#/settings';
      await loadCloud(); Cloud.loadProviders(); render();
      setTimeout(() => $('#account')?.scrollIntoView({ behavior: 'smooth' }), 50);
      break;
    case 'club-copy':
      try { await navigator.clipboard.writeText(el.dataset.link); toast('Invite link copied'); }
      catch { prompt('Copy this link:', el.dataset.link); }
      break;
    case 'club-share':
      navigator.share({ title: el.dataset.name, text: `Join my book club "${el.dataset.name}" on Bibliophile`, url: el.dataset.link }).catch(() => {});
      break;
    case 'club-reset':
      if (!confirm('Make a new invite link? The old one will stop working.')) break;
      try { await Clubs.resetInvite(id); toast('New link ready'); } catch (err) { toast(err.message); }
      render();
      break;
    case 'club-remove':
      if (!confirm(`Remove ${el.dataset.name} from the club?`)) break;
      try { await Clubs.removeMember(id, el.dataset.user); toast(`${el.dataset.name} was removed`); } catch (err) { toast(err.message); }
      render();
      break;
    case 'club-myname': {
      const n = prompt('Your name in book clubs:', Clubs.cachedName() || db.settings.name || '');
      if (!n || !n.trim()) break;
      try { await Clubs.setName(n); await Clubs.refreshClub(location.hash.split('/')[2]); toast('Name updated'); } catch (err) { toast(err.message); }
      render();
      break;
    }
    case 'club-leave': {
      const msg = el.dataset.n === '1' ? 'You\'re the only member, so leaving closes the club. Leave?'
        : el.dataset.owner ? 'Leave this club? The longest-standing member will take over running it.' : 'Leave this club?';
      if (!confirm(msg)) break;
      try { await Clubs.leaveClub(id); toast('You left the club'); location.hash = '#/clubs'; } catch (err) { toast(err.message); }
      break;
    }
    case 'cloud-open': ui.cloudOpen = true; await loadCloud(); Cloud.loadProviders(); render(); break;
    case 'cloud-close': ui.cloudOpen = false; if (Cloud && !Cloud.getStatus().configured) Cloud = null; render(); break;
    case 'cloud-forget-config': Cloud.setConfig('', ''); render(); break;
    case 'cloud-google': Cloud.signInWithGoogle(); break;
    case 'cloud-email-cancel': Cloud.cancelEmail(); break;
    case 'cloud-sync': Cloud.syncNow(); break;
    case 'cloud-restore': Cloud.restoreFromCloud().then(() => toast('Restored from your other devices')); break;
    case 'cloud-allow-deletes':
      if (confirm(`Delete these ${Cloud.getStatus().guard?.deletes || 0} books and passages from all your devices?`)) Cloud.syncNow({ allowDeletes: true });
      break;
    case 'cloud-signout':
      el.disabled = true;
      await Cloud.signOut();
      clearClubData();
      ui.cloudOpen = false;
      toast('Signed out. Everything is still on this device.');
      render();
      break;
    case 'cloud-delete-copy':
      if (!confirm('Delete your library from the cloud and sign out? It stays on this device. Your other devices keep their copy until you sign out there too.')) break;
      try { await Cloud.deleteCloudCopy(); clearClubData(); toast('Cloud copy deleted. You\'re back in personal mode.'); } catch (err) { toast('Couldn\'t delete: ' + err.message); }
      render();
      break;
    case 'cloud-delete-account':
      if (!confirm('Delete your account and everything stored in it? Your library stays on this device.') || prompt('Type DELETE to confirm') !== 'DELETE') break;
      try { await Cloud.deleteAccount(); clearClubData(); toast('Account deleted. You\'re back in personal mode.'); } catch (err) { toast('Couldn\'t delete: ' + err.message); }
      render();
      break;
    case 'export-md': download(`bibliophile-${today()}.md`, allMarkdown()); break;
    case 'wipe':
      if (confirm('Erase ALL books, highlights and settings from this device?' + (Cloud?.getStatus().signedIn ? ' You\'ll be signed out first, so your cloud copy and other devices are not affected.' : '')) && prompt('Type ERASE to confirm') === 'ERASE') {
        if (Cloud?.getStatus().signedIn) { await Cloud.signOut(); clearClubData(); }
        db.books = []; db.items = []; db.reviewLog = {}; clearCovers(); save(); toast('All data erased');
      }
      break;
    case 'lib-status': ui.libStatus = el.dataset.value; render(); break;
    case 'book-kind': ui.bookKind = el.dataset.value; render(); break;
    case 'toggle-fav-filter': ui.nFav = !ui.nFav; render(); break;
    case 'filter-tag':
      ui.nTag = ui.nTag === el.dataset.tag ? '' : el.dataset.tag;
      if (!location.hash.startsWith('#/notes')) location.hash = '#/notes'; else render();
      break;
    case 'timer-start': {
      const t = db.timer;
      if (t && t.bookId !== id && !confirm(`Stop the timer for “${getBook(t.bookId)?.title || 'another book'}” and start this one?`)) break;
      if (!t || t.bookId !== id) { db.timer = { bookId: id, startedAt: Date.now(), elapsed: 0 }; if (focusCfg().on) db.timer.focus = newFocus(); }
      else if (!t.startedAt) t.startedAt = Date.now();
      save();
      location.hash = '#/timer';
      break;
    }
    case 'timer-pause': { const t = db.timer; if (t?.startedAt) { t.elapsed += Date.now() - t.startedAt; t.startedAt = null; save(); Sound.onTimerPause(); } break; }
    case 'timer-resume': { const t = db.timer; if (t && !t.startedAt) { t.startedAt = Date.now(); save(); Sound.onTimerResume(); } break; }
    case 'timer-stop': {
      const t = db.timer; if (!t) break;
      const minutes = Math.max(1, Math.round(timerMs() / 60000));
      const book = getBook(t.bookId);
      db.timer = null; save();
      Sound.stopAll();                       // reading's done: let the music fade out
      if (book) sessionForm(book, { minutes });
      break;
    }
    case 'timer-discard':
      if (confirm('Discard this reading session without logging it?')) { db.timer = null; save(); Sound.stopAll(); }
      break;
    case 'dictate': toggleDictation(el); break;
    case 'undo-tidy': {
      const t = lastTidy;
      if (t && t.target.isConnected && t.target.value === joinText(t.before, t.text)) {
        t.target.value = joinText(t.before, t.spoken);
        t.target.dispatchEvent(new Event('input', { bubbles: true }));
      }
      lastTidy = null; el.parentElement.textContent = '';
      break;
    }
    case 'tidy-review': tidyFlow(getBook(id), el); break;
    case 'social': socialModal(getBook(id)); break;
    case 'year-card': yearModal(); break;
    case 'test-ai': {
      const key = $('form[data-form=ai] [name=geminiKey]').value.trim();
      if (!key) { toast('Paste a key first'); break; }
      el.disabled = true; el.textContent = 'Testing…';
      try { const model = await testKey(key); db.settings.geminiKey = key; save(); toast(`It works — using ${model}`); }
      catch (err) { alert('That key did not work: ' + err.message); el.disabled = false; el.textContent = 'Test it'; }
      break;
    }
    case 'remove-ai':
      if (confirm('Remove your AI key from this device?')) { db.settings.geminiKey = ''; save(); toast('Key removed'); }
      break;
    case 'lookup-word': lookupWord(el); break;
    case 'word-from': {
      const src = getItem(id);
      const picked = (ui.lastSelection || '').trim();
      const word = picked && !/\s/.test(picked) && src.text.toLowerCase().includes(picked.toLowerCase()) ? picked.replace(/^[^\w]+|[^\w]+$/g, '') : '';
      // Use just the sentence containing the word, not the whole passage, when we can find it.
      let context = src.text;
      if (word) {
        const sentence = src.text.split(/(?<=[.!?…])\s+/).find((s) => s.toLowerCase().includes(word.toLowerCase()));
        if (sentence) context = sentence;
      }
      itemForm({ kind: 'word', text: word, context, bookId: src.bookId, source: src.source, page: src.page, chapter: src.chapter });
      if (!word) toast('Tip: select the word in the passage first, then tap + Word');
      break;
    }
    case 'rec-refresh': startRecs(true); break;
    case 'rec-filter': ui.recFilter = el.dataset.value; render(); break;
    case 'rec-no': ui.recAsk[el.dataset.key] = true; render(); break;
    case 'rec-cancel': delete ui.recAsk[el.dataset.key]; render(); break;
    case 'rec-dismiss': {
      const c = recCard(el.dataset.key); if (!c) break;
      Recs.dismiss(c, el.dataset.reason); ui.recRemoved[c.key] = el.dataset.reason; delete ui.recAsk[c.key]; render();
      break;
    }
    case 'rec-undo': Recs.undismiss(el.dataset.key); delete ui.recRemoved[el.dataset.key]; render(); break;
    case 'rec-want':
    case 'rec-read': {
      const c = recCard(el.dataset.key); if (!c) break;
      const status = a === 'rec-want' ? 'want' : 'finished';
      const book = Recs.addToLibrary(c, status);
      ui.recAdded[c.key] = { id: book.id, status };
      ensureCover(book);
      render();
      toast(status === 'want' ? `Added “${c.title}” to Want to read` : `Added “${c.title}” — give it a rating`);
      break;
    }
    case 'go-timer': location.hash = '#/timer'; break;
    case 'focus-preset': {
      db.settings.focus = { ...focusCfg(), ...FOCUS_PRESETS[el.dataset.v] }; ui.focusCustom = false;
      if (db.timer?.focus) Object.assign(db.timer.focus, FOCUS_PRESETS[el.dataset.v]);
      save(); break;
    }
    case 'focus-custom': ui.focusCustom = true; render(); break;
    case 'focus-skip': startNextBlock(); break;
    case 'copy-redirect': await navigator.clipboard?.writeText(Spotify.redirectUri()).catch(() => {}); toast('Copied — paste it into Redirect URIs'); break;
    case 'sp-connect': Spotify.connect().catch((err) => alert(err.message)); break;
    case 'sp-disconnect': if (confirm('Disconnect Spotify from this browser?')) { Spotify.disconnect(); render(); toast('Spotify disconnected'); } break;
    case 'shuffle-daily': ui.dailyOffset += 1 + Math.floor(Math.random() * 7); render(); break;
    case 'reveal': ui.revealed = true; render(); break;
    case 'review':
      reviewItem(ui.reviewQueue[ui.reviewIdx], el.dataset.value);
      ui.reviewIdx++; ui.revealed = false; render();
      break;
    case 'review-more': {
      const seen = new Set(ui.reviewQueue);
      const more = db.items.filter((i) => !seen.has(i.id) && !i.rv?.archived).sort(() => Math.random() - 0.5).slice(0, 5).map((i) => i.id);
      if (!more.length) { toast("You've seen everything for now"); break; }
      ui.reviewQueue.push(...more); render();
      break;
    }
  }
});

document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.dataset.coverUpload) {
    const f = el.files?.[0];
    if (f) useUploadedCover(getBook(el.dataset.coverUpload), f).then(() => { closeModal(); toast('Cover saved'); }).catch(() => toast('Couldn’t read that image'));
    return;
  }
  if (el.dataset.change) {
    ui[el.dataset.change] = el.value;
    if (el.dataset.change === 'libSort') { db.settings.libSort = el.value; save({ quiet: true }); } // remember how you like the library arranged
    render(); return;
  }
  if (el.matches('[data-timer-pick]') && el.value) { db.timer = { bookId: el.value, startedAt: Date.now(), elapsed: 0 }; if (focusCfg().on) db.timer.focus = newFocus(); save(); return; }
  if (el.dataset.focus) { focusSetting(el); return; }
  if (el.dataset.actionChange === 'status') {
    const b = getBook(el.dataset.id);
    upsertBook({ id: b.id, status: el.value });
    if (el.value === 'finished') {
      if (b.pages) b.currentPage = b.pages;
      save();
      toast('Finished. Write a few lines while it\'s fresh.');
      setTimeout(() => $('#review-text')?.focus(), 50);
    }
    return;
  }
  if (el.dataset.import && el.files?.[0]) {
    try {
      const text = await readFile(el.files[0]);
      const kind = el.dataset.import;
      if (kind === 'kindle') { const r = importKindle(text); toast(`Imported ${r.added} highlights${r.skipped ? ` (${r.skipped} duplicates skipped)` : ''}`); }
      if (kind === 'readwise') { const r = importReadwise(text); toast(`Imported ${r.added} highlights${r.skipped ? ` (${r.skipped} duplicates skipped)` : ''}`); }
      if (kind === 'goodreads') { const r = importGoodreads(text); toast(`Added ${r.added} books, updated ${r.updated} — fetching covers in the background`); }
      if (kind === 'json') { importJSON(text, 'merge'); await importCovers(JSON.parse(text).coverImages); toast('Backup merged'); }
      if (kind === 'json-replace') {
        if (confirm('Replace ALL current data with this backup?')) {
          importJSON(text, 'replace'); await clearCovers(); await importCovers(JSON.parse(text).coverImages, { overwrite: true });
          applyTheme(); toast('Backup restored');
        }
      }
      if (['kindle', 'readwise', 'goodreads', 'json', 'json-replace'].includes(kind)) ensureAll(db.books);
    } catch (err) {
      alert('Import failed: ' + err.message);
    }
    el.value = '';
  }
});

let inputTimer;
document.addEventListener('input', (e) => {
  const el = e.target;
  if (!el.dataset.input) return;
  clearTimeout(inputTimer);
  inputTimer = setTimeout(() => {
    ui[el.dataset.input] = el.value;
    const pos = el.selectionStart;
    render();
    const again = $(`[data-input="${el.dataset.input}"]`);
    if (again) { again.focus(); again.setSelectionRange(pos, pos); }
  }, 200);
});

document.addEventListener('submit', (e) => {
  const form = e.target;
  const type = form.dataset.form;
  if (!type) return;
  e.preventDefault();
  const fd = Object.fromEntries(new FormData(form));
  if (type === 'book') {
    const data = {
      title: fd.title.trim(), author: fd.author.trim(), status: fd.status, format: fd.format,
      pages: Number(fd.pages) || 0, year: fd.year.trim(), isbn: fd.isbn.trim(),
      startedAt: fd.startedAt, finishedAt: fd.finishedAt, tags: parseTags(fd.tags), cover: fd.cover.trim(),
    };
    if (fd.id) data.id = fd.id;
    if (!fd.id && data.status === 'finished' && data.pages) data.currentPage = data.pages;
    const before = fd.id ? getBook(fd.id)?.cover : null;
    const b = upsertBook(data);
    if (!fd.id) clearDraft('book');
    closeModal();
    const file = fd.coverFile && fd.coverFile.size ? fd.coverFile : null;
    if (file) useUploadedCover(b, file).then(() => toast('Cover saved')).catch(() => toast('Could not read that image'));
    else ensureCover(b, { force: !!fd.id && data.cover !== before });
    if (!fd.id) { location.hash = `#/book/${b.id}`; toast('Book added'); }
  } else if (type === 'item') {
    const isWord = fd.kind === 'word';
    const data = {
      kind: fd.kind,
      text: (isWord ? fd.word : fd.text).trim(),
      note: (isWord ? fd.meaning : fd.note).trim(),
      context: isWord ? fd.context.trim() : '',
      bookId: fd.bookId, source: fd.bookId ? '' : fd.source.trim(),
      page: fd.page.trim(), chapter: fd.chapter.trim(), tags: parseTags(fd.tags), favorite: !!fd.favorite,
    };
    if (fd.id) data.id = fd.id;
    upsertItem(data);
    clearDraft('item');
    toast('Saved');
    if (e.submitter?.name === 'again') {
      itemForm({ kind: data.kind, bookId: data.bookId, source: data.source, chapter: data.chapter, tags: data.tags }, data.bookId);
    } else closeModal();
  } else if (type === 'session') {
    logSession(fd.id, { date: fd.date, toPage: Number(fd.toPage) || 0, minutes: Number(fd.minutes) || 0 });
    closeModal();
    const b = getBook(fd.id);
    toast(b.status === 'finished' ? 'Finished. Add your review below.' : 'Progress logged');
  } else if (type === 'settings') {
    Object.assign(db.settings, {
      name: fd.name.trim(), yearlyGoal: Number(fd.yearlyGoal) || 0, dailyMinutes: Math.max(5, Number(fd.dailyMinutes) || 30),
      dailyReview: Math.max(1, Number(fd.dailyReview) || 5), theme: fd.theme,
    });
    save(); applyTheme(); toast('Settings saved');
  } else if (type === 'cover-url') {
    saveChosenCover(getBook(fd.id), (fd.url || '').trim());
  } else if (type === 'club-new' || type === 'club-join' || type === 'club-edit') {
    const btn = $('button.primary', form); const label = btn.textContent; btn.disabled = true; btn.textContent = 'Just a moment…';
    const done = () => { btn.disabled = false; btn.textContent = label; };
    const job = type === 'club-new' ? Clubs.createClub(fd.name.trim(), (fd.description || '').trim(), fd.me.trim()).then((id) => { toast('Book club created — now invite your friends'); location.hash = '#/club/' + id; })
      : type === 'club-join' ? Clubs.joinClub(fd.code, fd.me.trim()).then((id) => { delete clubFetch['join:' + fd.code]; toast('Welcome to the club'); location.hash = '#/club/' + id; })
      : Clubs.updateClub(fd.id, fd.name.trim(), (fd.description || '').trim()).then(() => { toast('Saved'); render(); });
    job.catch((err) => { toast(err.message); done(); });
  } else if (type === 'cloud-config') {
    try { Cloud.setConfig(fd.url, fd.anonKey); toast('Saved'); Cloud.loadProviders(); } catch (err) { toast(err.message); }
    render();
  } else if (type === 'cloud-email') {
    const btn = $('button.primary', form); btn.disabled = true; btn.textContent = 'Sending…';
    Cloud.sendEmailCode(fd.email).then(() => toast('Sent — check your email'))
      .catch((err) => { toast(err.message); btn.disabled = false; btn.textContent = 'Email me a sign-in link'; });
  } else if (type === 'cloud-code') {
    const btn = $('button.primary', form); btn.disabled = true; btn.textContent = 'Signing in…';
    Cloud.verifyEmailCode(fd.code).then((r) => { toast(`Signed in as ${r.email} — syncing your library`); render(); afterSignIn(); })
      .catch((err) => { toast(err.message); btn.disabled = false; btn.textContent = 'Sign in'; });
  } else if (type === 'spotify') {
    db.settings.spotifyClientId = (fd.spotifyClientId || '').trim();
    save(); toast(db.settings.spotifyClientId ? 'Saved — now press Connect Spotify' : 'Client ID cleared');
  } else if (type === 'ai') {
    db.settings.geminiKey = fd.geminiKey.trim();
    db.settings.geminiModel = (fd.geminiModel || '').trim();
    db.settings.geminiModelManual = !!db.settings.geminiModel;
    db.settings.autoTidy = !!fd.autoTidy;
    save(); toast(db.settings.geminiKey ? 'Key saved — press “Test it” to check it' : 'Key cleared');
  }
});

document.addEventListener('keydown', (e) => {
  if (dlg.open || e.metaKey || e.ctrlKey || e.altKey) return;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
  const onReview = location.hash.startsWith('#/review');
  if (onReview && ['1', '2', '3'].includes(e.key)) {
    const btn = $$('[data-action=review]')[Number(e.key) - 1];
    btn && btn.click();
    return;
  }
  if (e.key === 'n') { e.preventDefault(); itemForm({}, location.hash.startsWith('#/book/') ? location.hash.split('/')[2] : ''); }
  else if (e.key === 'b') { e.preventDefault(); bookForm(); }
  else if (e.key === '/') { e.preventDefault(); location.hash = '#/notes'; setTimeout(() => $('[data-input=nQuery]')?.focus(), 0); }
  else if (e.key === 'r') location.hash = '#/review';
  else if (e.key === 't') location.hash = '#/timer';
});

// ---------- boot ----------
applyTheme();
initChartTooltips();
Sound.init();
Sound.mount($('#sound-dock'));
render();
Spotify.handleRedirect().then((r) => { if (!r) return; render(); toast(r.ok ? 'Spotify connected — pick a playlist in the reading room' : r.message); })
  .catch(() => toast('Spotify sign-in failed — try again'));
// Optional sync: only loaded if you've switched it on (or are coming back from signing in).
if (cloudWanted() || /[?&]auth=cloud|[#&](access_token|error_description)=/.test(location.search + location.hash)) {
  loadCloud().then(async (C) => {
    C.loadProviders();
    const r = await C.handleRedirect();
    if (r) { toast(r.ok ? `Signed in as ${r.email} — syncing your library` : r.message); }
    render();
    if (r?.ok) afterSignIn();
  }).catch(() => {});
}
onCoverChange(render);
loadCovers().then(() => {
  render();
  // Quietly save covers for any books that don't have one yet (e.g. added before this feature).
  setTimeout(() => ensureAll(db.books), 3000);
});
// Home-screen shortcuts open e.g. index.html?do=add
{
  const act = new URLSearchParams(location.search).get('do');
  if (act) history.replaceState(null, '', location.pathname + location.hash);
  if (act === 'add') itemForm({}, db.timer?.bookId || '');
}
setInterval(tickTimer, 1000);
tickTimer();
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
