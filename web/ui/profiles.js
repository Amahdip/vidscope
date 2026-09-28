// Expectation profiles for the audit: what a service intends its outputs to be (a GOP length, a
// sample rate, a colour description, a loudness target...). "Standards only" checks what the
// standards say and nothing else; an audit server can offer its own profiles; anyone can load a
// profile from a JSON file (kept in this browser).

import { loadPref, savePref } from './store.js';
import { validateExpect } from '../core/audit.js';

const BUILTIN = [{ id: 'standards', name: 'Standards only', description: 'What the standards say, with no service contract', source: 'built in' }];
const cache = new Map([['standards', {}]]);

// Profiles loaded from files live in this browser (and, if storage is refused, for this page).
let session = null;

function userProfiles() {
  if (session) return session;
  const list = loadPref('auditProfiles', []);
  return Array.isArray(list) ? list : [];
}

function saveUserProfiles(list) {
  session = list;
  savePref('auditProfiles', list);
}

/** Every profile on offer, as { id, name, description, source }. */
export function listProfiles(server) {
  const fromServer = (server?.profiles ?? []).map((p) => ({ id: `server:${p.id}`, name: p.name, description: p.description ?? '', source: 'audit server' }));
  const mine = userProfiles().map((p) => ({ id: p.id, name: p.name, description: 'loaded from a file', source: 'this browser' }));
  return [...BUILTIN, ...fromServer, ...mine];
}

/** The profile to use: the one chosen before if it still exists, else the server's default, else the standards. */
export function currentProfile(server, chosen = loadPref('auditProfile', null)) {
  const all = listProfiles(server);
  if (chosen && all.some((p) => p.id === chosen)) return chosen;
  if (server?.defaultProfile && all.some((p) => p.id === `server:${server.defaultProfile}`)) return `server:${server.defaultProfile}`;
  return 'standards';
}

export function chooseProfile(id) {
  savePref('auditProfile', id);
}

/** The expectations of a profile (fetched once from the audit server when it is one of its). */
export async function profileExpect(id) {
  if (cache.has(id)) return cache.get(id);
  let expect = {};
  if (id.startsWith('server:')) {
    const res = await fetch(`api/audit/profile/${encodeURIComponent(id.slice(7))}`);
    if (!res.ok) throw new Error(`the audit server has no profile ${id.slice(7)} (HTTP ${res.status})`);
    expect = await res.json();
  } else {
    expect = userProfiles().find((p) => p.id === id)?.expect ?? {};
  }
  cache.set(id, expect);
  return expect;
}

/** Load a profile from a JSON file; returns its id. Throws with a readable message when a key is wrong. */
export async function loadProfileFile(file) {
  const text = await file.text();
  let expect;
  try {
    expect = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file.name} is not JSON: ${e.message}`);
  }
  validateExpect(expect);
  const name = file.name.replace(/\.json$/i, '');
  const id = `user:${name}`;
  const list = userProfiles().filter((p) => p.id !== id);
  list.push({ id, name, expect });
  saveUserProfiles(list);
  cache.set(id, expect);
  return id;
}

export function forgetProfile(id) {
  saveUserProfiles(userProfiles().filter((p) => p.id !== id));
  cache.delete(id);
}
