/**
 * Shared cache for the prep steps that fetch from the internet, so running
 * them several times in a row (e.g. npm run android while testing) doesn't
 * download the same things again. Anything fetched less than CACHE_TTL_MS ago
 * is reused; pass --no-cache to fetch fresh copies.
 *
 * Files live under node_modules/.cache, which git ignores and which goes away
 * with node_modules.
 */

import fs from 'fs';
import path from 'path';

export const CACHE_TTL_MS = 5 * 60 * 60_000; // 5 hours
export const CACHE_DIR = path.join(__dirname, '../../node_modules/.cache/climweb-prep');

/** Path for a cached file, creating its folder. */
export function cachePath(name: string): string {
  const file = path.join(CACHE_DIR, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

/** Whether file exists and was written less than CACHE_TTL_MS ago. */
export function isFresh(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  return Date.now() - fs.statSync(file).mtimeMs < CACHE_TTL_MS;
}

/** How long ago file was written, e.g. "2h 5m ago". */
export function age(file: string): string {
  const minutes = Math.round((Date.now() - fs.statSync(file).mtimeMs) / 60_000);
  return minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
}
