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
export function clearCache() { cache = {}; localStorage.removeItem(CACHE_KEY); }

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
