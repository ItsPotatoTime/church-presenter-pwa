// Local first-seen stamps for song lists, used ONLY as the fallback creation
// time when the desktop/cloud does not carry one (older builds). Newer peers
// send `created_ts` on every list, which always wins over these values.
//
// The map lives in localStorage keyed by normalized list name and is cached in
// module scope: the Lists page reads timestamps inside $derived sorting, which
// runs on every render — localStorage must not be touched per read.

import { normalizedListName } from './db';

const KEY = 'pwa_list_created_ts_v1';

let cache: Record<string, number> | null = null;

function load(): Record<string, number> {
  if (cache !== null) return cache;
  const fresh: Record<string, number> = {};
  if (typeof window !== 'undefined') {
    try {
      const raw = window.localStorage.getItem(KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object') Object.assign(fresh, parsed);
    } catch {
      // Corrupt JSON: start fresh rather than crashing the page.
    }
  }
  cache = fresh;
  return fresh;
}

function persist(): void {
  if (typeof window === 'undefined' || cache === null) return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // Storage full or private mode: sorting still works this session.
  }
}

/** Stamp unseen names with Date.now(). Returns how many were added. */
export function ensureListCreatedTs(names: string[]): number {
  const map = load();
  const now = Date.now();
  let added = 0;
  for (const name of names) {
    const key = normalizedListName(name);
    if (!key || map[key] !== undefined) continue;
    map[key] = now;
    added++;
  }
  if (added > 0) persist();
  return added;
}

/**
 * Effective creation time for a list: the authoritative server value when it
 * carries one, else this device's first-seen stamp, else "unknown" (which the
 * caller renders at the end of Newest/Oldest orderings).
 *
 * Server values arrive in epoch milliseconds, but the cloud hub historically
 * stamps in seconds; anything below 1e11 cannot be a plausible millisecond
 * date, so scale it up here. This also sanitizes rows already stored with a
 * seconds value.
 */
export function effectiveListCreatedTs(
  name: string,
  serverTs: number | undefined,
): number | undefined {
  if (serverTs !== undefined && serverTs > 0) {
    return serverTs < 100_000_000_000 ? serverTs * 1000 : serverTs;
  }
  return load()[normalizedListName(name)];
}

/** Keep a renamed list's fallback age when no server stamp exists yet. */
export function renameListCreatedTs(oldName: string, newName: string): void {
  const map = load();
  const from = normalizedListName(oldName);
  const to = normalizedListName(newName);
  if (!from || !to || from === to) return;
  const ts = map[from];
  delete map[from];
  if (ts !== undefined && map[to] === undefined) map[to] = ts;
  persist();
}

export function deleteListCreatedTs(name: string): void {
  const map = load();
  const key = normalizedListName(name);
  if (!key || map[key] === undefined) return;
  delete map[key];
  persist();
}
