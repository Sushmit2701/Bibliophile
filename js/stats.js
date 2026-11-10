// Stats page: how much you read, when, and what. Everything is drawn as plain SVG/HTML.
// Chart rules followed here: rings only for a value against a goal, bars in one hue for amounts
// (the current day/month emphasised), a segmented bar — not a pie — for the genre split, a legend
// with names and shares for anything with several colours, hover/focus tooltips on every mark,
// and a "See the numbers" table for each chart.
import { db, today, addDays, localDate, itemsForBook, KINDS, ASPECTS } from './store.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const fmtNum = (n) => (n >= 10000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, '') + 'k' : n.toLocaleString());
export function fmtMinutes(m) {
  m = Math.round(m);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

// ---------- genres from Open Library subjects (looked up for recommendations) ----------
const GENRES = [
  ['Science fiction', /science fiction|dystop|time travel|space opera|robots|artificial intelligence|post-apocalyptic/],
  ['Fantasy', /fantasy|magic|dragons|wizards|fairy tales/],
  ['Mystery & thriller', /myster|thriller|detective|crime|suspense|murder|spy/],
  ['Romance', /romance|love stories/],
  ['Historical fiction', /historical fiction|history.*fiction/],
  ['Horror', /horror|ghost stories|supernatural/],
  ['Biography & memoir', /biograph|memoir|autobiograph/],
  ['History & society', /(^|\| )history|world history|military history|civilization|politics|sociology|anthropology|economics/],
  ['Science & nature', /(^|\| )science($| \|)|popular science|physics|biology|evolution|neuroscience|psychology|nature|astronomy|mathematics/],
  ['Philosophy & religion', /philosoph|stoic|religion|spiritual|ethics|buddhism|theology/],
  ['Self-help & business', /self-help|success|personal development|business|management|productivity|habits/],
  ['Poetry', /poetry|poems/],
  ['Literary fiction', /fiction|novel|literary/],
];
export function genreOf(book) {
  const text = [...(book.ol?.subjects || []), ...(book.tags || [])].join(' | ').toLowerCase();
  if (!text) return null;
  for (const [name, re] of GENRES) if (re.test(text)) return name;
  return 'Other non-fiction';
}

// ---------- the numbers ----------
function sessionsByDay() {
  const days = new Map();
  for (const b of db.books) for (const s of b.sessions || []) {
    const d = days.get(s.date) || { minutes: 0, pages: 0 };
    d.minutes += s.minutes || 0;
    d.pages += Math.max(0, (s.toPage || 0) - (s.fromPage || 0));
    days.set(s.date, d);
  }
  return days;
}

export function computeStats(liveTimerMinutes = 0) {
  const t = today();
  const year = t.slice(0, 4), month = t.slice(0, 7);
  const days = sessionsByDay();
  const day = (d) => days.get(d) || { minutes: 0, pages: 0 };
  const todayStat = { ...day(t) };
  todayStat.minutes += liveTimerMinutes;

  const week = [];
  for (let i = 6; i >= 0; i--) { const d = addDays(t, -i); week.push({ date: d, ...day(d), ...(i === 0 ? { minutes: todayStat.minutes } : {}) }); }
  const sumRange = (pred) => { let m = 0, p = 0; for (const [d, v] of days) if (pred(d)) { m += v.minutes; p += v.pages; } return { minutes: m, pages: p }; };
  const thisMonth = sumRange((d) => d.startsWith(month));
  const thisYear = sumRange((d) => d.startsWith(year));
  thisMonth.minutes += liveTimerMinutes; thisYear.minutes += liveTimerMinutes;

  // reading streak: consecutive days with any reading, today optional
  let streak = 0; let d = todayStat.minutes || todayStat.pages ? t : addDays(t, -1);
  while ((days.get(d)?.minutes || days.get(d)?.pages) || (d === t && liveTimerMinutes)) { streak++; d = addDays(d, -1); }
  let best = 0, run = 0;
  for (const k of [...days.keys()].sort()) { const prev = addDays(k, -1); run = days.has(prev) && (days.get(prev).minutes || days.get(prev).pages) ? run + 1 : 1; best = Math.max(best, run); }
  best = Math.max(best, streak);

  // pace from sessions that logged both pages and minutes
  let pm = 0, pp = 0;
  for (const v of days.values()) if (v.minutes && v.pages) { pm += v.minutes; pp += v.pages; }
  const pagesPerHour = pm >= 30 ? Math.round((pp / pm) * 60) : 0;

  const finished = db.books.filter((b) => b.status === 'finished');
  const finishedYear = finished.filter((b) => (b.finishedAt || '').startsWith(year));
  const months = Array.from({ length: 12 }, (_, i) => ({ m: i, books: 0 }));
  for (const b of finishedYear) { const m = Number(b.finishedAt.slice(5, 7)) - 1; if (m >= 0) months[m].books++; }
  const pagesYear = Math.max(thisYear.pages, finishedYear.reduce((s, b) => s + (Number(b.pages) || 0), 0));

  // genres (finished + reading)
  const counted = db.books.filter((b) => b.status === 'finished' || b.status === 'reading');
  const g = new Map(); let unknown = 0;
  for (const b of counted) { const name = genreOf(b); if (!name) { unknown++; continue; } g.set(name, (g.get(name) || 0) + 1); }
  let genres = [...g.entries()].sort((a, b) => b[1] - a[1]);
  if (genres.length > 5) { const rest = genres.slice(5).reduce((s, [, n]) => s + n, 0); genres = [...genres.slice(0, 5), ['Other', rest]]; }

  // ratings
  const rated = db.books.filter((b) => b.rating);
  const buckets = [5, 4, 3, 2, 1].map((s) => ({ stars: s, n: rated.filter((b) => Math.floor(b.rating) === s || (s === 5 && b.rating >= 5)).length }));
  const avgRating = rated.length ? rated.reduce((s, b) => s + b.rating, 0) / rated.length : 0;
  const aspects = Object.entries(ASPECTS).map(([k, a]) => {
    const vals = db.books.map((b) => b.aspects?.[k]).filter((v) => v > 0);
    return { key: k, label: a.label, avg: vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0, n: vals.length };
  });

  // formats
  const formats = ['print', 'ebook', 'audiobook'].map((f) => ({ f, n: counted.filter((b) => (b.format || 'print') === f).length })).filter((x) => x.n);

  // passages
  const kinds = Object.keys(KINDS).map((k) => ({ k, label: KINDS[k].label, n: db.items.filter((i) => i.kind === k).length })).filter((x) => x.n).sort((a, b) => b.n - a.n);
  const topHighlighted = db.books.map((b) => [b, itemsForBook(b.id).length]).filter(([, n]) => n).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const authors = {};
  for (const b of finished) if (b.author) authors[b.author] = (authors[b.author] || 0) + 1;
  const topAuthors = Object.entries(authors).sort((a, b) => b[1] - a[1]).slice(0, 5);

  // heatmap: last 52 weeks
  const perDay = new Map([...days].map(([k, v]) => [k, v.pages || (v.minutes ? Math.max(1, v.minutes / 2) : 0)]));
  for (const [k, n] of Object.entries(db.reviewLog || {})) if (n && !perDay.get(k)) perDay.set(k, 0.0001);

  return {
    t, year, todayStat, week, thisMonth, thisYear, streak, best, pagesPerHour,
    finished, finishedYear, months, pagesYear, genres, unknown, counted: counted.length,
    rated, buckets, avgRating, aspects, formats, kinds, topHighlighted, topAuthors, perDay,
    goalBooks: db.settings.yearlyGoal || 0, goalMinutes: db.settings.dailyMinutes || 30,
  };
}

// ---------- small chart builders ----------
function ring({ value, max, size = 150, stroke = 14, label, sub, id }) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const frac = max ? Math.min(1, value / max) : 0;
  return `
  <div class="ring" style="width:${size}px;height:${size}px" role="img" aria-label="${esc(label)} ${esc(sub)}">
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <defs><linearGradient id="rg-${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="var(--ring-a)"/><stop offset="1" stop-color="var(--ring-b)"/></linearGradient></defs>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--ring-track)" stroke-width="${stroke}"/>
      ${frac > 0 ? `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="url(#rg-${id})" stroke-width="${stroke}" stroke-linecap="round"
        stroke-dasharray="${(c * frac).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 ${size / 2} ${size / 2})" class="ring-fill"/>` : ''}
    </svg>
    <div class="ring-label"><b>${esc(label)}</b><span>${esc(sub)}</span></div>
  </div>`;
}

// Columns from one baseline, 4px rounded tops, one hue; the emphasised column (today / this month) in the accent.
function columns({ data, value, label, tip, emphasis, height = 150, fmt = (v) => v, aria }) {
  const max = Math.max(1, ...data.map(value));
  const nice = niceMax(max);
  return `
  <div class="cols" role="img" aria-label="${esc(aria)}" style="--h:${height}px">
    <div class="cols-grid"><span data-v="${esc(fmt(nice))}"></span><span data-v="${esc(fmt(nice / 2))}"></span><span data-v="0"></span></div>
    <div class="cols-bars">
      ${data.map((d, i) => {
        const v = value(d);
        const h = v ? Math.max(4, (v / nice) * height) : 0;
        const isEm = emphasis(d, i);
        return `<div class="col-wrap" tabindex="0" data-tip="${esc(tip(d))}">
          <div class="col-bar ${isEm ? 'em' : ''}" style="height:${h}px"></div>
          <span class="col-x ${isEm ? 'em' : ''}">${esc(label(d))}</span>
        </div>`;
      }).join('')}
    </div>
  </div>`;
}
function niceMax(v) {
  if (v <= 4) return 4;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function hbars(rows, { fmt = (v) => v, aria }) {
  const max = Math.max(1, ...rows.map((r) => r.v));
  return `<div class="hbars" role="img" aria-label="${esc(aria)}">${rows.map((r) => `
    <div class="hbar-row" tabindex="0" data-tip="${esc(r.tip || `${r.label}: ${fmt(r.v)}`)}">
      <span class="hbar-label">${r.labelHTML || esc(r.label)}</span>
      <span class="hbar-track"><span class="hbar-fill" style="width:${r.v ? Math.max(2, (r.v / max) * 100) : 0}%"></span></span>
      <span class="hbar-val">${esc(fmt(r.v))}</span>
    </div>`).join('')}</div>`;
}

// Tall segmented bar for one whole split into parts (genres). Categorical slots in fixed order.
const SLOTS = ['var(--cat-1)', 'var(--cat-2)', 'var(--cat-3)', 'var(--cat-4)', 'var(--cat-5)', 'var(--cat-other)'];
function segmented(parts, { aria, unit }) {
  const total = parts.reduce((s, [, n]) => s + n, 0) || 1;
  return `
  <div class="seg" role="img" aria-label="${esc(aria)}">
    ${parts.map(([name, n], i) => {
      const pct = Math.round((n / total) * 100);
      const color = name === 'Other' ? SLOTS[5] : SLOTS[i];
      return `<div class="seg-part" tabindex="0" style="flex:${n};background:${color}" data-tip="${esc(`${name}: ${plural(n, unit)} · ${pct}%`)}">${pct >= 12 ? `<span>${pct}%</span>` : ''}</div>`;
    }).join('')}
  </div>
  <ul class="legend">${parts.map(([name, n], i) => `<li><i style="background:${name === 'Other' ? SLOTS[5] : SLOTS[i]}"></i>${esc(name)}<span>${n} · ${Math.round((n / total) * 100)}%</span></li>`).join('')}</ul>`;
}

function dataTable(head, rows) {
  return `<details class="data-table"><summary>See the numbers</summary><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></details>`;
}

const DOW = (d) => new Date(d + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short' });
const MON = (m) => new Date(2026, m, 1).toLocaleDateString(undefined, { month: 'short' });

// ---------- the page ----------
export function statsHTML(liveTimerMinutes = 0, { fmtDate }) {
  const s = computeStats(liveTimerMinutes);
  const nowMonth = Number(s.t.slice(5, 7)) - 1;
  const goalPct = s.goalMinutes ? Math.round((s.todayStat.minutes / s.goalMinutes) * 100) : 0;
  const weekMin = s.week.reduce((a, d) => a + d.minutes, 0);
  const weekPages = s.week.reduce((a, d) => a + d.pages, 0);
  const avgDay = weekMin / 7;
  const lastWeekMin = (() => { let m = 0; for (let i = 7; i < 14; i++) m += (sessionsByDay().get(addDays(s.t, -i))?.minutes || 0); return m; })();
  const delta = lastWeekMin ? Math.round(((weekMin - lastWeekMin) / lastWeekMin) * 100) : null;
  const expected = s.goalBooks ? s.goalBooks * ((Date.now() - new Date(Number(s.year), 0, 1)) / (365 * 864e5)) : 0;
  const pace = s.goalBooks ? Math.round(s.finishedYear.length - expected) : 0;

  // heatmap cells
  const start = addDays(s.t, -7 * 52 + 1 - new Date().getDay());
  let cells = '';
  for (let d = start; d <= s.t; d = addDays(d, 1)) {
    const n = s.perDay.get(d) || 0;
    const lvl = n === 0 ? 0 : n < 1 ? 1 : n < 20 ? 2 : n < 50 ? 3 : 4;
    cells += `<span class="cell l${lvl}" tabindex="-1" data-tip="${esc(`${fmtDate(d)}: ${n >= 1 ? Math.round(n) + ' pages' : n ? 'reviewed passages' : 'no reading'}`)}"></span>`;
  }
  const weekDots = s.week.map((d) => `<span class="wd ${d.minutes || d.pages ? 'on' : ''} ${d.date === s.t ? 'today' : ''}" title="${esc(DOW(d.date))}">${esc(DOW(d.date).slice(0, 1))}</span>`).join('');

  return `
  <header class="page-head">
    <div><div class="eyebrow">Your reading</div><h1>Stats</h1></div>
    <button class="btn primary" data-action="year-card">Share my year</button>
  </header>

  <div class="stats-grid">
    <section class="card st-today">
      <div class="st-head"><h2>Today</h2><span class="muted small">${new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' })}</span></div>
      <div class="st-today-body">
        ${ring({ value: s.todayStat.minutes, max: s.goalMinutes, label: fmtMinutes(s.todayStat.minutes), sub: `of ${s.goalMinutes} min`, id: 'today' })}
        <div class="st-figures">
          <div><b>${s.todayStat.pages}</b><span>pages today</span></div>
          <div><b>${goalPct >= 100 ? 'Done' : `${Math.max(0, s.goalMinutes - Math.round(s.todayStat.minutes))} min`}</b><span>${goalPct >= 100 ? 'daily goal reached' : 'to your daily goal'}</span></div>
          ${liveTimerMinutes ? '<div class="live"><span class="tb-dot live"></span>timer running</div>' : `<button class="btn sm" data-action="go-timer">Start reading</button>`}
        </div>
      </div>
    </section>

    <section class="card st-year">
      <div class="st-head"><h2>${s.year}</h2><span class="muted small">reading goal</span></div>
      <div class="st-today-body">
        ${ring({ value: s.finishedYear.length, max: s.goalBooks || Math.max(1, s.finishedYear.length), label: String(s.finishedYear.length), sub: s.goalBooks ? `of ${s.goalBooks} books` : 'books', id: 'year' })}
        <div class="st-figures">
          <div><b>${fmtNum(s.pagesYear)}</b><span>pages this year</span></div>
          <div><b>${fmtMinutes(s.thisYear.minutes)}</b><span>time read</span></div>
          ${s.goalBooks ? `<div><b>${pace === 0 ? 'On pace' : Math.abs(pace)}</b><span>${pace === 0 ? 'right on track' : `${Math.abs(pace) === 1 ? 'book' : 'books'} ${pace > 0 ? 'ahead of' : 'behind'} pace`}</span></div>` : ''}
        </div>
      </div>
    </section>

    <section class="card st-streak">
      <div class="st-head"><h2>Streak</h2></div>
      <div class="st-big"><b>${s.streak}</b><span>${s.streak === 1 ? 'day' : 'days'} in a row</span></div>
      <div class="week-dots" aria-label="Days read this week">${weekDots}</div>
      <p class="muted small">Best run: ${plural(s.best, 'day')}</p>
    </section>

    <section class="card st-week">
      <div class="st-head"><h2>This week</h2><span class="muted small">minutes read each day</span></div>
      <div class="kpis">
        <div><b>${fmtMinutes(weekMin)}</b><span>total</span></div>
        <div><b>${fmtMinutes(avgDay)}</b><span>a day on average</span></div>
        <div><b>${weekPages}</b><span>pages</span></div>
        ${delta != null ? `<div><b class="${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta)}%</b><span>vs last week</span></div>` : ''}
      </div>
      ${columns({
        data: s.week, value: (d) => d.minutes, label: (d) => (d.date === s.t ? 'Today' : DOW(d.date)),
        tip: (d) => `${DOW(d.date)} ${fmtDate(d.date)} · ${fmtMinutes(d.minutes)}${d.pages ? ` · ${d.pages} pages` : ''}`,
        emphasis: (d) => d.date === s.t, fmt: (v) => `${Math.round(v)}m`, aria: `Minutes read on each of the last 7 days, ${fmtMinutes(weekMin)} in total`,
      })}
      ${dataTable(['Day', 'Minutes', 'Pages'], s.week.map((d) => [`${DOW(d.date)} ${fmtDate(d.date)}`, Math.round(d.minutes), d.pages]))}
    </section>

    <section class="card st-time">
      <div class="st-head"><h2>Time spent reading</h2></div>
      <ul class="time-list">
        <li><span>Today</span><b>${fmtMinutes(s.todayStat.minutes)}</b></li>
        <li><span>This week</span><b>${fmtMinutes(weekMin)}</b></li>
        <li><span>This month</span><b>${fmtMinutes(s.thisMonth.minutes)}</b></li>
        <li><span>This year</span><b>${fmtMinutes(s.thisYear.minutes)}</b></li>
        <li><span>Reading pace</span><b>${s.pagesPerHour ? `${s.pagesPerHour} pages/hr` : '—'}</b></li>
      </ul>
      <p class="muted small">From the reading timer and the sessions you log.</p>
    </section>

    <section class="card st-months">
      <div class="st-head"><h2>Books finished</h2><span class="muted small">${s.year}, by month</span></div>
      <div class="kpis">
        <div><b>${s.finishedYear.length}</b><span>this year</span></div>
        <div><b>${s.finished.length}</b><span>all time</span></div>
        <div><b>${s.avgRating ? s.avgRating.toFixed(1) : '—'}</b><span>average rating</span></div>
      </div>
      ${columns({
        data: s.months, value: (d) => d.books, label: (d) => MON(d.m).slice(0, 3),
        tip: (d) => `${MON(d.m)} · ${plural(d.books, 'book')}`, emphasis: (d) => d.m === nowMonth, aria: `Books finished each month of ${s.year}`,
        height: 130,
      })}
      ${dataTable(['Month', 'Books'], s.months.map((d) => [MON(d.m), d.books]))}
    </section>

    <section class="card st-genres">
      <div class="st-head"><h2>What you read</h2><span class="muted small">by genre</span></div>
      ${s.genres.length ? segmented(s.genres, { aria: `Genres of ${s.counted} books: ${s.genres.map(([n, c]) => `${n} ${c}`).join(', ')}`, unit: 'book' })
        : `<p class="muted">Genres appear once your books' subjects are looked up — open <a href="#/foryou">Recommendations</a> once.</p>`}
      ${s.unknown && s.genres.length ? `<p class="muted small">${plural(s.unknown, 'book')} without genre information yet.</p>` : ''}
    </section>

    <section class="card st-ratings">
      <div class="st-head"><h2>Your ratings</h2><span class="muted small">${plural(s.rated.length, 'rated book')}</span></div>
      ${s.rated.length ? hbars(s.buckets.map((b) => ({ label: `${b.stars}★`, labelHTML: `<span class="stars-mini">${'★'.repeat(b.stars)}</span>`, v: b.n, tip: `${b.stars}${b.stars < 5 ? '–' + b.stars + '.5' : ''} stars: ${plural(b.n, 'book')}` })), { aria: 'Number of books at each star rating' })
        : '<p class="muted">Rate a few books to see your spread.</p>'}
      ${s.aspects.some((a) => a.n) ? `
      <div class="aspect-pills">
        ${s.aspects.map((a) => `<div class="pill" tabindex="0" data-tip="${esc(`${a.label}: ${a.n ? a.avg.toFixed(1) + ' / 5 across ' + plural(a.n, 'book') : 'not rated yet'}`)}">
          <div class="pill-tube"><div class="pill-fill" style="height:${(a.avg / 5) * 100}%"></div></div>
          <small>${esc(a.label.split(' ')[0])}</small><b>${a.n ? a.avg.toFixed(1) : '—'}</b></div>`).join('')}
      </div>` : ''}
    </section>

    <section class="card st-passages">
      <div class="st-head"><h2>What you save</h2><span class="muted small">${plural(db.items.length, 'passage')}</span></div>
      ${s.kinds.length ? hbars(s.kinds.map((k) => ({ label: k.label + 's', v: k.n })), { aria: 'Saved passages by type' }) : '<p class="muted">Nothing saved yet.</p>'}
      ${s.formats.length > 1 ? `<div class="st-sub"><h3>How you read</h3>${hbars(s.formats.map((f) => ({ label: f.f[0].toUpperCase() + f.f.slice(1), v: f.n })), { aria: 'Books by format' })}</div>` : ''}
    </section>

    <section class="card st-heat">
      <div class="st-head"><h2>Activity</h2><span class="muted small">the last 12 months</span></div>
      <div class="heatmap">${cells}</div>
      <div class="heat-legend"><span class="muted small">Less</span>${[0, 1, 2, 3, 4].map((l) => `<span class="cell l${l}"></span>`).join('')}<span class="muted small">More pages</span></div>
    </section>

    <section class="card st-authors">
      <div class="st-head"><h2>Most-read authors</h2></div>
      ${s.topAuthors.length ? `<ol class="rank">${s.topAuthors.map(([a, n]) => `<li><span>${esc(a)}</span><b>${n}</b></li>`).join('')}</ol>` : '<p class="muted">Finish a book to see this.</p>'}
    </section>

    <section class="card st-highlighted">
      <div class="st-head"><h2>Most highlighted</h2></div>
      ${s.topHighlighted.length ? `<ol class="rank">${s.topHighlighted.map(([b, n]) => `<li><a href="#/book/${b.id}">${esc(b.title)}</a><b>${n}</b></li>`).join('')}</ol>` : '<p class="muted">—</p>'}
    </section>
  </div>`;
}

// One tooltip for every chart mark: follows the pointer, and keyboard focus.
let tipEl;
export function initChartTooltips() {
  if (tipEl) return;
  tipEl = document.createElement('div');
  tipEl.className = 'chart-tip'; tipEl.setAttribute('role', 'tooltip'); tipEl.hidden = true;
  document.body.appendChild(tipEl);
  const show = (el, x, y) => {
    tipEl.textContent = el.dataset.tip; tipEl.hidden = false;
    const r = tipEl.getBoundingClientRect();
    tipEl.style.left = Math.min(window.innerWidth - r.width - 8, Math.max(8, x - r.width / 2)) + 'px';
    tipEl.style.top = Math.max(8, y - r.height - 12) + 'px';
    document.querySelectorAll('.tip-on').forEach((n) => n.classList.remove('tip-on'));
    el.classList.add('tip-on');
  };
  const hide = () => { tipEl.hidden = true; document.querySelectorAll('.tip-on').forEach((n) => n.classList.remove('tip-on')); };
  document.addEventListener('pointermove', (e) => {
    const el = e.target.closest?.('[data-tip]');
    if (el) show(el, e.clientX, e.clientY); else if (!tipEl.hidden) hide();
  });
  document.addEventListener('focusin', (e) => {
    const el = e.target.closest?.('[data-tip]');
    if (!el) return hide();
    const r = el.getBoundingClientRect();
    show(el, r.left + r.width / 2, r.top);
  });
  window.addEventListener('scroll', hide, { passive: true });
}
