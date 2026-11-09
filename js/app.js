import {
  db, save, onChange, uid, today, addDays, KINDS, STATUSES, ASPECTS, suggestedRating, fmtRating,
  getBook, upsertBook, deleteBook, logSession,
  getItem, itemsForBook, upsertItem, deleteItem, allTags,
  buildReviewQueue, reviewItem, reviewStreak, exportJSON, importJSON,
} from './store.js';
import { importKindle, importReadwise, importGoodreads } from './importers.js';
import { quoteCard, download, bookMarkdown, allMarkdown } from './share.js';
import { hasAI, testKey, tidyLocally, tidyReview, captionTemplate, reelTemplate, aiCaption, aiReel, DEFAULT_MODEL } from './ai.js';
import { yearCard, yearsWithReading, YEAR_THEMES } from './yearcard.js';
import {
  loadCovers, onCoverChange, coverSrc, hasSavedCover, savedCoverCount, ensureCover, ensureAll,
  useUploadedCover, removeCover, clearCovers, exportCovers, importCovers,
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
function cover(book, size = '') {
  const cloth = CLOTH[hashHue(book.title || "?") % CLOTH.length];
  const fallback = `<div class="cover-fallback" style="--cloth:${cloth}"><span>${esc(book.title)}</span><small>${esc(book.author)}</small></div>`;
  const src = coverSrc(book);
  if (!src) return `<div class="cover ${size}">${fallback}</div>`;
  return `<div class="cover ${size}"><img src="${esc(src)}" alt="" loading="lazy" onerror="this.remove()">${fallback}</div>`;
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
function openModal(html, onMount) {
  $('#modal-body').innerHTML = html;
  dlg.showModal();
  onMount && onMount($('#modal-body'));
  const first = $('#modal-body [autofocus]');
  first && first.focus();
}
function closeModal() { dlg.close(); }
dlg.addEventListener('click', (e) => { if (e.target === dlg) closeModal(); });

// ---------- router ----------
const routes = {
  '': viewHome,
  library: viewLibrary,
  book: viewBook,
  notes: viewNotes,
  review: viewReview,
  stats: viewStats,
  timer: viewTimer,
  settings: viewSettings,
};
const ui = { // transient UI state that survives re-renders
  libStatus: 'all', libSort: 'recent', libQuery: '',
  nKind: 'all', nQuery: '', nTag: '', nFav: false, nBook: '',
  bookKind: 'all', reviewQueue: null, reviewIdx: 0, revealed: false, dailyOffset: 0,
};

function render() {
  const [route, param] = location.hash.replace(/^#\/?/, '').split('/');
  const view = routes[route] || viewHome;
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === (routes[route] ? route : '')));
  const main = $('#main');
  const scroll = window.scrollY;
  const sameRoute = main.dataset.route === location.hash;
  main.innerHTML = view(decodeURIComponent(param || ''));
  main.dataset.route = location.hash;
  if (sameRoute) window.scrollTo(0, scroll);
  else { window.scrollTo(0, 0); main.classList.remove('enter'); void main.offsetWidth; main.classList.add('enter'); }
  const due = db.items.length > 0 && !db.reviewLog[today()];
  $$('.review-dot').forEach((d) => d.hidden = !due);
  renderTimerBar(route);
}
window.addEventListener('hashchange', () => { if (location.hash.split('/')[1] !== 'review') ui.reviewQueue = null; render(); });
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
    ? `<div class="word"><strong>${esc(i.text)}</strong>${i.note ? `<div class="definition">${nl2br(i.note)}</div>` : ''}</div>`
    : `<blockquote class="${opts.big ? 'big' : ''}">${nl2br(i.text)}</blockquote>${i.note ? `<div class="note"><span class="note-label">My note</span>${nl2br(i.note)}</div>` : ''}`;
  return `
    <article class="item kind-${i.kind}" data-id="${i.id}">
      <div class="item-top">
        <span class="kind-badge" title="${kind.label}">${kind.label}</span>
        ${meta ? `<span class="muted small">${meta}</span>` : ''}
      </div>
      ${body}
      ${!opts.noAttribution && attribution ? `<div class="attribution">— ${attribution}</div>` : ''}
      ${i.tags?.length ? `<div class="tags">${i.tags.map((t) => `<a class="tag" href="#/notes" data-action="filter-tag" data-tag="${esc(t)}">#${esc(t)}</a>`).join('')}</div>` : ''}
      ${opts.noActions ? '' : `
      <div class="item-actions">
        <button class="icon-btn ${i.favorite ? 'fav' : ''}" data-action="fav" data-id="${i.id}" title="Favorite">${i.favorite ? '♥' : '♡'}</button>
        <button class="icon-btn" data-action="copy" data-id="${i.id}" title="Copy">⧉</button>
        ${i.kind !== 'word' ? `<button class="icon-btn" data-action="card" data-id="${i.id}" title="Share as image">▣</button>` : ''}
        <button class="icon-btn" data-action="edit-item" data-id="${i.id}" title="Edit">✎</button>
        <button class="icon-btn" data-action="delete-item" data-id="${i.id}" title="Delete">🗑</button>
      </div>`}
    </article>`;
}

function viewLibrary() {
  const counts = { all: db.books.length };
  for (const b of db.books) counts[b.status] = (counts[b.status] || 0) + 1;
  const q = ui.libQuery.toLowerCase();
  let list = db.books.filter((b) => (ui.libStatus === 'all' || b.status === ui.libStatus)
    && (!q || `${b.title} ${b.author} ${(b.tags || []).join(' ')}`.toLowerCase().includes(q)));
  const sorters = {
    recent: (a, b) => (b.finishedAt || b.updatedAt || '').localeCompare(a.finishedAt || a.updatedAt || ''),
    title: (a, b) => a.title.localeCompare(b.title),
    author: (a, b) => (a.author.split(' ').pop() || '').localeCompare(b.author.split(' ').pop() || ''),
    rating: (a, b) => (b.rating || 0) - (a.rating || 0),
    highlights: (a, b) => itemsForBook(b.id).length - itemsForBook(a.id).length,
  };
  list.sort(sorters[ui.libSort] || sorters.recent);

  return `
    <header class="page-head">
      <h1>Library</h1>
      <button class="btn primary" data-action="add-book">+ Add book</button>
    </header>
    <div class="toolbar">
      <div class="chips">
        ${['all', ...Object.keys(STATUSES)].map((s) => `<button class="chip ${ui.libStatus === s ? 'on' : ''}" data-action="lib-status" data-value="${s}">${s === 'all' ? 'All' : STATUSES[s]} <span class="count">${counts[s] || 0}</span></button>`).join('')}
      </div>
      <div class="row gap">
        <input type="search" placeholder="Search books…" value="${esc(ui.libQuery)}" data-input="libQuery">
        <select data-change="libSort">
          ${Object.entries({ recent: 'Recent', title: 'Title', author: 'Author', rating: 'Rating', highlights: 'Most highlights' }).map(([k, v]) => `<option value="${k}" ${ui.libSort === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
      </div>
    </div>
    ${list.length ? `<div class="shelf">${list.map((b) => {
      const n = itemsForBook(b.id).length;
      return `<a class="shelf-book" href="#/book/${b.id}">
        ${cover(b)}
        <div class="shelf-title">${esc(b.title)}</div>
        <div class="muted small">${esc(b.author)}</div>
        <div class="small shelf-meta">${b.rating ? stars(b.rating) : `<span class="status-pill s-${b.status}">${STATUSES[b.status]}</span>`}${n ? ` <span class="muted">· ${n} ❝</span>` : ''}</div>
      </a>`;
    }).join('')}</div>` : `<p class="empty">No books here yet.</p>`}
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
        ${hasSavedCover(b.id) ? '' : `<button class="link-btn" data-action="find-cover" data-id="${b.id}">${b.cover ? 'Save cover offline' : 'Find the cover'}</button>`}
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
        <textarea id="review-text" rows="${b.review ? Math.min(16, b.review.split('\n').length + 3) : 4}" placeholder="What did you think? What will you remember? Who would you recommend it to?">${esc(b.review)}</textarea>
        <div class="voice-row">
          ${micButton('#review-text', 'Speak your review')}
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
      const hay = `${i.text} ${i.note} ${i.source} ${(i.tags || []).join(' ')} ${b ? b.title + ' ' + b.author : ''}`.toLowerCase();
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
          <div class="item-top"><span class="kind-badge">Aa Word</span></div>
          <div class="word"><strong>${esc(item.text)}</strong></div>
          <p class="muted">Do you remember what it means?</p>
          <button class="btn" data-action="reveal">Show definition</button>
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

function viewStats() {
  const finished = db.books.filter((b) => b.status === 'finished');
  const byYear = {};
  for (const b of finished) { const y = (b.finishedAt || '').slice(0, 4) || 'Unknown'; (byYear[y] ||= []).push(b); }
  const years = Object.keys(byYear).sort().reverse();
  const maxYear = Math.max(1, ...Object.values(byYear).map((l) => l.length));
  const pagesRead = finished.reduce((s, b) => s + (Number(b.pages) || 0), 0);
  const rated = finished.filter((b) => b.rating);
  const avg = rated.length ? (rated.reduce((s, b) => s + b.rating, 0) / rated.length).toFixed(1) : '—';
  const authors = {};
  for (const b of finished) if (b.author) authors[b.author] = (authors[b.author] || 0) + 1;
  const topAuthors = Object.entries(authors).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const topHighlighted = db.books.map((b) => [b, itemsForBook(b.id).length]).filter(([, n]) => n).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const kinds = {};
  for (const i of db.items) kinds[i.kind] = (kinds[i.kind] || 0) + 1;
  const aspectStats = Object.entries(ASPECTS).map(([k, asp]) => {
    const scored = db.books.filter((b) => b.aspects?.[k] > 0);
    if (!scored.length) return null;
    const best = scored.slice().sort((x, y) => y.aspects[k] - x.aspects[k] || (y.rating || 0) - (x.rating || 0))[0];
    return { asp, avg: scored.reduce((t, b) => t + b.aspects[k], 0) / scored.length, best };
  }).filter(Boolean);

  // pages per day for the last 26 weeks (from reading sessions)
  const perDay = {};
  for (const b of db.books) for (const s of b.sessions || []) perDay[s.date] = (perDay[s.date] || 0) + Math.max(0, s.toPage - s.fromPage);
  for (const [d, n] of Object.entries(db.reviewLog)) perDay[d] = perDay[d] || (n ? 0.0001 : 0);
  const start = addDays(today(), -7 * 26 + 1 - new Date().getDay());
  let cells = '';
  for (let d = start; d <= today(); d = addDays(d, 1)) {
    const n = perDay[d] || 0;
    const lvl = n === 0 ? 0 : n < 1 ? 1 : n < 20 ? 2 : n < 50 ? 3 : 4;
    cells += `<span class="cell l${lvl}" title="${fmtDate(d)}: ${n >= 1 ? Math.round(n) + ' pages' : n ? 'reviewed' : 'no reading'}"></span>`;
  }
  const monthNow = today().slice(0, 7);
  const thisMonth = finished.filter((b) => (b.finishedAt || '').startsWith(monthNow)).length;

  return `
    <header class="page-head"><h1>Stats</h1><button class="btn primary" data-action="year-card">Share my year</button></header>
    <div class="stat-tiles">
      <div class="tile"><div class="num">${finished.length}</div><div class="muted small">books finished</div></div>
      <div class="tile"><div class="num">${pagesRead.toLocaleString()}</div><div class="muted small">pages read</div></div>
      <div class="tile"><div class="num">${db.items.length}</div><div class="muted small">passages saved</div></div>
      <div class="tile"><div class="num">${avg}</div><div class="muted small">avg rating</div></div>
      <div class="tile"><div class="num">${thisMonth}</div><div class="muted small">finished this month</div></div>
      <div class="tile"><div class="num">${reviewStreak()}</div><div class="muted small">day review streak</div></div>
    </div>

    <section class="section card">
      <h2>Activity <span class="muted small">last 6 months</span></h2>
      <div class="heatmap">${cells}</div>
      <p class="muted small">Darker = more pages logged. Lighter dots are review-only days.</p>
    </section>

    <div class="grid-2">
      <section class="card">
        <h2>Books per year</h2>
        ${years.length ? years.map((y) => `<div class="bar-row"><span>${y}</span><div class="bar"><span style="width:${(byYear[y].length / maxYear) * 100}%"></span></div><b>${byYear[y].length}</b></div>`).join('') : '<p class="muted">Finish a book to see this.</p>'}
      </section>
      <section class="card">
        <h2>Most-read authors</h2>
        ${topAuthors.length ? `<ol class="rank">${topAuthors.map(([a, n]) => `<li>${esc(a)} <span class="muted">${n}</span></li>`).join('')}</ol>` : '<p class="muted">—</p>'}
      </section>
      <section class="card">
        <h2>Most highlighted</h2>
        ${topHighlighted.length ? `<ol class="rank">${topHighlighted.map(([b, n]) => `<li><a href="#/book/${b.id}">${esc(b.title)}</a> <span class="muted">${n}</span></li>`).join('')}</ol>` : '<p class="muted">—</p>'}
      </section>
      ${aspectStats.length ? `<section class="card">
        <h2>Rating breakdown</h2>
        ${aspectStats.map(({ asp, avg: av, best }) => `<div class="bar-row wide"><span>${asp.label}</span><div class="bar"><span style="width:${(av / 5) * 100}%"></span></div><b>${av.toFixed(1)}</b></div>
          <div class="muted small best">Best: <a href="#/book/${best.id}">${esc(best.title)}</a></div>`).join('')}
      </section>` : ''}
      <section class="card">
        <h2>What you save</h2>
        ${Object.keys(kinds).length ? `<ol class="rank plain">${Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<li>${KINDS[k]?.icon || ''} ${KINDS[k]?.label || k}s <span class="muted">${n}</span></li>`).join('')}</ol>` : '<p class="muted">—</p>'}
      </section>
    </div>
  `;
}

function viewSettings() {
  const s = db.settings;
  const bytes = new Blob([JSON.stringify(db)]).size;
  return `
    <header class="page-head"><h1>Settings</h1></header>

    <section class="card section">
      <h2>Preferences</h2>
      <form class="form" data-form="settings">
        <label>Your name <input name="name" value="${esc(s.name)}" placeholder="for the greeting"></label>
        <label>Yearly reading goal <input name="yearlyGoal" type="number" min="0" value="${s.yearlyGoal}"></label>
        <label>Passages per daily review <input name="dailyReview" type="number" min="1" max="50" value="${s.dailyReview}"></label>
        <label>Theme
          <select name="theme">${Object.entries({ auto: 'Follow device', light: 'Ivory (light)', dark: 'Library at night (dark)' }).map(([k, v]) => `<option value="${k}" ${s.theme === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
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

    <section class="card section">
      <h2>AI assistant <span class="muted small">optional</span></h2>
      <p class="muted small">Used for <b>Tidy with AI</b> (turns a rambling voice note into a clean review) and <b>Create a post</b> (captions and reel scripts). It uses Google's Gemini, which has a free tier: get a key at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> (sign in with Google, click <i>Create API key</i>), then paste it here.</p>
      <p class="muted small">The key is stored only in this browser and is never included in backups. Text is sent to Google only when you press an AI button. On the free tier, Google may use what you send to improve its products — don't send anything private.</p>
      <form class="form" data-form="ai">
        <label>Gemini API key <input name="geminiKey" type="password" autocomplete="off" value="${esc(s.geminiKey || '')}" placeholder="AIza…"></label>
        <label>Model <input name="geminiModel" value="${esc(s.geminiModel || '')}" placeholder="${DEFAULT_MODEL} (picked automatically if retired)"></label>
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
  const clock = t ? fmtClock(timerMs()) : '';
  $$('.timer-clock').forEach((el) => { el.textContent = clock; });
  document.title = t && t.startedAt ? `${clock} · ${getBook(t.bookId)?.title || 'Reading'}` : 'Bibliophile';
}
function renderTimerBar(route) {
  const bar = $('#timer-bar');
  const t = db.timer;
  const book = t && getBook(t.bookId);
  if (!book || route === 'timer') { bar.hidden = true; return; }
  bar.hidden = false;
  bar.innerHTML = `
    <a href="#/timer" class="tb-main"><span class="tb-dot ${t.startedAt ? 'live' : ''}"></span><span class="tb-title">${esc(book.title)}</span><span class="timer-clock">${fmtClock(timerMs())}</span></a>
    ${t.startedAt ? '<button class="link-btn" data-action="timer-pause">Pause</button>' : '<button class="link-btn" data-action="timer-resume">Resume</button>'}
    <button class="link-btn" data-action="timer-stop">Done</button>`;
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
        </select></p>` : ''}`;
  }
  const running = !!t.startedAt;
  return `
    <section class="reading-room">
      <div class="eyebrow center">${running ? 'Now reading' : 'Paused'}</div>
      <a href="#/book/${book.id}">${cover(book, 'lg')}</a>
      <h1>${esc(book.title)}</h1>
      <p class="byline">${esc(book.author)}${book.pages ? ` · from p. ${book.currentPage || 0}` : ''}</p>
      <div class="timer-clock big ${running ? '' : 'paused'}">${fmtClock(timerMs())}</div>
      <div class="row gap center wrap">
        ${running ? '<button class="btn" data-action="timer-pause">Pause</button>' : '<button class="btn" data-action="timer-resume">Resume</button>'}
        <button class="btn primary" data-action="timer-stop">Finish &amp; log</button>
      </div>
      <div class="row center gap room-links">
        <button class="link-btn" data-action="add-item" data-book="${book.id}">Save a passage</button>
        <button class="link-btn" data-action="timer-discard">Discard</button>
      </div>
    </section>`;
}

// ============ VOICE DICTATION ============
// Uses the browser's built-in speech recognition (Chrome, Edge, Safari, Android). Free, no key needed.
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
function micButton(target, label = 'Dictate') {
  if (!SpeechRec) return '';
  return `<button type="button" class="link-btn mic" data-action="dictate" data-target="${target}"><span class="mic-dot"></span>${label}</button>`;
}
function toggleDictation(btn) {
  if (rec) { rec.stop(); return; }
  const target = $(btn.dataset.target, btn.closest('dialog') || document);
  if (!target) return;
  const interim = btn.parentElement.querySelector('.interim');
  const label = btn.innerHTML;
  rec = new SpeechRec();
  rec.lang = navigator.language || 'en-US';
  rec.continuous = true;
  rec.interimResults = true;
  rec.onresult = (ev) => {
    let live = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) {
        const txt = r[0].transcript.trim();
        target.value = (target.value && !/\s$/.test(target.value) ? target.value + ' ' : target.value) + txt;
      } else live += r[0].transcript;
    }
    if (interim) interim.textContent = live;
  };
  rec.onerror = (ev) => { if (ev.error === 'not-allowed') toast('Microphone permission was blocked'); };
  rec.onend = () => { rec = null; btn.classList.remove('on'); btn.innerHTML = label; if (interim) interim.textContent = ''; target.dispatchEvent(new Event('input')); };
  rec.start();
  btn.classList.add('on');
  btn.innerHTML = '<span class="mic-dot"></span>Listening… tap to stop';
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
    catch (err) { toast('AI unavailable — did a basic tidy instead'); console.warn(err); viaAI = false; }
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
  const names = { ivory: 'Ivory', night: 'Library at night', oxblood: 'Oxblood' };
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

// ============ FORMS ============

function bookForm(book = {}) {
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
  });
}

function itemForm(item = {}, presetBook = '') {
  const isNew = !item.id;
  const bookId = item.bookId ?? presetBook;
  const books = db.books.slice().sort((a, b) => (b.status === 'reading') - (a.status === 'reading') || a.title.localeCompare(b.title));
  const kind = item.kind || 'highlight';
  openModal(`
    <h2>${isNew ? 'Save a passage' : 'Edit'}</h2>
    <form class="form" data-form="item">
      <input type="hidden" name="id" value="${esc(item.id || '')}">
      <div class="kind-picker">
        ${Object.entries(KINDS).map(([k, v]) => `<label><input type="radio" name="kind" value="${k}" ${kind === k ? 'checked' : ''}><span>${v.icon} ${v.label}</span></label>`).join('')}
      </div>
      <label><span class="text-label">${kind === 'word' ? 'Word' : 'Text'}</span>
        <textarea name="text" rows="5" required autofocus placeholder="Type, paste or dictate the passage…">${esc(item.text || '')}</textarea>
      </label>
      ${SpeechRec ? `<div class="voice-row">${micButton('[name=text]', 'Dictate passage')}${micButton('[name=note]', 'Dictate note')}<span class="interim muted"></span></div>` : ''}
      <label><span class="note-label-text">${kind === 'word' ? 'Definition' : 'My note (optional)'}</span>
        <textarea name="note" rows="2" placeholder="Why it mattered, what it reminds you of…">${esc(item.note || '')}</textarea>
      </label>
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
      <label class="check"><input type="checkbox" name="favorite" ${item.favorite ? 'checked' : ''}> ♥ Favorite</label>
      <div class="row gap end">
        <button type="button" class="btn ghost" data-action="close">Cancel</button>
        ${isNew ? '<button class="btn" name="again" value="1">Save & add another</button>' : ''}
        <button class="btn primary">Save</button>
      </div>
    </form>`, (root) => {
    const f = $('form', root);
    f.bookId.addEventListener('change', () => { $('.source-field', root).hidden = !!f.bookId.value; });
    $$('input[name=kind]', root).forEach((r) => r.addEventListener('change', () => {
      const w = f.kind.value === 'word';
      $('.text-label', root).textContent = w ? 'Word' : 'Text';
      $('.note-label-text', root).textContent = w ? 'Definition' : 'My note (optional)';
      f.text.rows = w ? 1 : 5;
    }));
    if (kind === 'word') f.text.rows = 1;
  });
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

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  const id = el.dataset.id;
  if (el.tagName === 'A' || el.tagName === 'BUTTON') e.preventDefault();

  switch (a) {
    case 'close': closeModal(); break;
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
    case 'save-review': {
      const b = getBook(id);
      b.review = $('#review-text').value.trim();
      b.reviewUpdatedAt = new Date().toISOString();
      save(); toast('Review saved');
      break;
    }
    case 'prompt': {
      const ta = $('#review-text');
      ta.value = (ta.value.trim() ? ta.value.trimEnd() + '\n\n' : '') + el.dataset.text;
      ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
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
    case 'export-md': download(`bibliophile-${today()}.md`, allMarkdown()); break;
    case 'wipe':
      if (confirm('Erase ALL books, highlights and settings from this device?') && prompt('Type ERASE to confirm') === 'ERASE') {
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
      if (!t || t.bookId !== id) db.timer = { bookId: id, startedAt: Date.now(), elapsed: 0 };
      else if (!t.startedAt) t.startedAt = Date.now();
      save();
      location.hash = '#/timer';
      break;
    }
    case 'timer-pause': { const t = db.timer; if (t?.startedAt) { t.elapsed += Date.now() - t.startedAt; t.startedAt = null; save(); } break; }
    case 'timer-resume': { const t = db.timer; if (t && !t.startedAt) { t.startedAt = Date.now(); save(); } break; }
    case 'timer-stop': {
      const t = db.timer; if (!t) break;
      const minutes = Math.max(1, Math.round(timerMs() / 60000));
      const book = getBook(t.bookId);
      db.timer = null; save();
      if (book) sessionForm(book, { minutes });
      break;
    }
    case 'timer-discard':
      if (confirm('Discard this reading session without logging it?')) { db.timer = null; save(); }
      break;
    case 'dictate': toggleDictation(el); break;
    case 'tidy-review': tidyFlow(getBook(id), el); break;
    case 'social': socialModal(getBook(id)); break;
    case 'year-card': yearModal(); break;
    case 'test-ai': {
      const key = $('form[data-form=ai] [name=geminiKey]').value.trim();
      if (!key) { toast('Paste a key first'); break; }
      el.disabled = true; el.textContent = 'Testing…';
      try { const model = await testKey(key); db.settings.geminiKey = key; db.settings.geminiModel = model; save(); toast(`It works — using ${model}`); }
      catch (err) { alert('That key did not work: ' + err.message); el.disabled = false; el.textContent = 'Test it'; }
      break;
    }
    case 'remove-ai':
      if (confirm('Remove your AI key from this device?')) { db.settings.geminiKey = ''; save(); toast('Key removed'); }
      break;
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
  if (el.dataset.change) { ui[el.dataset.change] = el.value; render(); return; }
  if (el.matches('[data-timer-pick]') && el.value) { db.timer = { bookId: el.value, startedAt: Date.now(), elapsed: 0 }; save(); return; }
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
    closeModal();
    const file = fd.coverFile && fd.coverFile.size ? fd.coverFile : null;
    if (file) useUploadedCover(b, file).then(() => toast('Cover saved')).catch(() => toast('Could not read that image'));
    else ensureCover(b, { force: !!fd.id && data.cover !== before });
    if (!fd.id) { location.hash = `#/book/${b.id}`; toast('Book added'); }
  } else if (type === 'item') {
    const data = {
      kind: fd.kind, text: fd.text.trim(), note: fd.note.trim(), bookId: fd.bookId, source: fd.bookId ? '' : fd.source.trim(),
      page: fd.page.trim(), chapter: fd.chapter.trim(), tags: parseTags(fd.tags), favorite: !!fd.favorite,
    };
    if (fd.id) data.id = fd.id;
    upsertItem(data);
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
      name: fd.name.trim(), yearlyGoal: Number(fd.yearlyGoal) || 0,
      dailyReview: Math.max(1, Number(fd.dailyReview) || 5), theme: fd.theme,
    });
    save(); applyTheme(); toast('Settings saved');
  } else if (type === 'ai') {
    db.settings.geminiKey = fd.geminiKey.trim();
    db.settings.geminiModel = fd.geminiModel.trim();
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
render();
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
