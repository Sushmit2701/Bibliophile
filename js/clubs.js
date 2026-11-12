// Book clubs (needs sync). Clubs live on your Supabase project; this keeps a copy of what you last
// saw so the pages open instantly and still show something offline.
import { rpc, publicRpc } from './cloud.js';

const CACHE_KEY = 'bibliophile:clubs-cache';
export const MAX_MEMBERS = 10;

const read = () => { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch { return {}; } };
let cache = read();
const persist = () => { try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch {} };

export const cachedList = () => cache.list || null;
export const cachedClub = (id) => cache.clubs?.[id] || null;
export const cachedName = () => cache.me || '';
export function clearCache() { cache = {}; localStorage.removeItem(CACHE_KEY); localStorage.removeItem('bibliophile:club-pushed'); }

export async function refreshList() {
  const [list, me] = await Promise.all([rpc('my_clubs'), rpc('my_profile')]);
  cache.list = list || [];
  cache.me = me?.display_name || '';
  // Forget clubs you're no longer in.
  for (const id of Object.keys(cache.clubs || {})) if (!cache.list.some((c) => c.id === id)) delete cache.clubs[id];
  persist();
  return cache.list;
}

export async function refreshClub(id) {
  try {
    const c = await rpc('club_details', { p_club: id });
    (cache.clubs ||= {})[id] = c;
    persist();
    return c;
  } catch (e) {
    if (/not a member/i.test(e.message)) { delete cache.clubs?.[id]; cache.list = (cache.list || []).filter((c) => c.id !== id); persist(); }
    throw e;
  }
}

export async function createClub(name, description, displayName) {
  const id = await rpc('create_club', { p_name: name, p_description: description, p_display_name: displayName });
  cache.me = displayName;
  await refreshList();
  return id;
}
export const preview = (code, signedIn) => (signedIn ? rpc : publicRpc)('club_preview', { p_code: code });
export async function joinClub(code, displayName) {
  const id = await rpc('join_club', { p_code: code, p_display_name: displayName });
  cache.me = displayName;
  await refreshList();
  return id;
}
export async function leaveClub(id) { await rpc('leave_club', { p_club: id }); delete cache.clubs?.[id]; await refreshList(); }
export async function updateClub(id, name, description) { await rpc('update_club', { p_club: id, p_name: name, p_description: description }); await refreshClub(id); await refreshList(); }
export async function resetInvite(id) { await rpc('reset_invite', { p_club: id }); return refreshClub(id); }
export async function removeMember(id, user) { await rpc('remove_member', { p_club: id, p_user: user }); return refreshClub(id); }
export async function setName(name) { await rpc('set_display_name', { p_name: name }); cache.me = name.trim(); persist(); }

export const inviteLink = (code) => location.origin + location.pathname + '#/join/' + code;

// ---------- reading together ----------
export const cachedReading = (id) => cache.reading?.[id] || null;
export async function refreshReading(id) {
  const r = await rpc('club_reading', { p_club: id });
  (cache.reading ||= {})[id] = r;
  persist();
  return r;
}
export async function chooseBook(club, b) {
  const id = await rpc('set_club_book', {
    p_club: club, p_title: b.title, p_author: b.author || '', p_cover: /^https:\/\//.test(b.cover || '') ? b.cover : '',
    p_pages: Number(b.pages) || 0, p_isbn: b.isbn || '',
  });
  await refreshReading(club);
  return id;
}
export async function finishBook(club) { await rpc('finish_club_book', { p_club: club }); return refreshReading(club); }
export async function addGoal(club, title, page, due) { await rpc('add_goal', { p_club: club, p_title: title, p_target_page: Number(page) || null, p_due: due }); return refreshReading(club); }
export async function removeGoal(club, goal) { await rpc('remove_goal', { p_goal: goal }); return refreshReading(club); }

// What this device has already told the clubs (your progress and the passages you chose to share),
// so only changes are sent.
const PUSH_KEY = 'bibliophile:club-pushed';
const readPushed = () => { try { return JSON.parse(localStorage.getItem(PUSH_KEY) || 'null') || { p: {}, s: {} }; } catch { return { p: {}, s: {} }; } };
const writePushed = (v) => { try { localStorage.setItem(PUSH_KEY, JSON.stringify(v)); } catch {} };
export function clearPushed() { localStorage.removeItem(PUSH_KEY); }

// A book's progress as the club sees it.
export const progressOf = (b) => ({ page: b.status === 'finished' ? (b.pages || b.currentPage || 0) : (b.currentPage || 0), status: b.status || 'reading' });
const gone = (e) => /not a member/i.test(e.message);

let busy = null, again = false;
export function reconcile(db) {
  if (busy) { again = true; return busy; }
  busy = (async () => {
    const pushed = readPushed();
    let changed = false;
    // Progress, for every library book linked to a club book.
    for (const b of db.books) {
      for (const l of b.clubLinks || []) {
        const { page, status } = progressOf(b);
        const sig = page + '|' + status;
        if (pushed.p[l.cb] === sig) continue;
        try { await rpc('set_progress', { p_book: l.cb, p_page: page, p_status: status }); }
        catch (e) { if (!gone(e)) throw e; }
        pushed.p[l.cb] = sig; changed = true; writePushed(pushed);
      }
    }
    // Passages you chose to share.
    const want = {};
    for (const i of db.items) for (const cb of i.sharedTo || []) if (i.text) want[cb + '|' + i.id] = i;
    for (const [k, i] of Object.entries(want)) {
      const sig = JSON.stringify([i.kind, i.text, i.note || '', i.page || '', i.chapter || '']);
      if (pushed.s[k] === sig) continue;
      try {
        await rpc('share_passage', { p_book: k.split('|')[0], p_item_id: i.id, p_kind: i.kind, p_text: i.text, p_note: i.note || '', p_page: String(i.page || ''), p_chapter: i.chapter || '' });
      } catch (e) { if (!gone(e)) throw e; }
      pushed.s[k] = sig; changed = true; writePushed(pushed);
    }
    // ...and stopped sharing (or deleted).
    for (const k of Object.keys(pushed.s)) {
      if (want[k]) continue;
      const [cb, item] = k.split('|');
      try { await rpc('unshare_passage', { p_book: cb, p_item_id: item }); } catch (e) { if (!gone(e)) throw e; }
      delete pushed.s[k]; changed = true; writePushed(pushed);
    }
    return changed;
  })().finally(() => {
    busy = null;
    if (again) { again = false; reconcile(db).catch(() => {}); }
  });
  return busy;
}

// After leaving a club: forget its links on this device (the club has already removed what you shared).
export function forgetClub(db, clubId) {
  const cbs = new Set();
  for (const b of db.books) {
    for (const l of b.clubLinks || []) if (l.club === clubId) cbs.add(l.cb);
    if (b.clubLinks?.some((l) => l.club === clubId)) b.clubLinks = b.clubLinks.filter((l) => l.club !== clubId);
  }
  for (const i of db.items) if (i.sharedTo?.some((cb) => cbs.has(cb))) i.sharedTo = i.sharedTo.filter((cb) => !cbs.has(cb));
  const pushed = readPushed();
  for (const cb of cbs) delete pushed.p[cb];
  for (const k of Object.keys(pushed.s)) if (cbs.has(k.split('|')[0])) delete pushed.s[k];
  writePushed(pushed);
  if (cache.reading) delete cache.reading[clubId];
  persist();
}
