/**
 * Conflict copies.
 *
 * When two devices edit the same note while one of them is offline, the newer
 * edit keeps the real path and the older one is written alongside it as
 * `Note (conflict 2026-08-21 1420 iPhone).md`. Nothing is ever discarded, and
 * because the copy is an ordinary note it syncs to every device like any other
 * file, so the loser's work shows up wherever they look next.
 */

import { basename, dirname, extname, MAX_PATH_LENGTH, normalizeVaultPath } from './paths.js';

const CONFLICT_MARKER = /\s\(conflict \d{4}-\d{2}-\d{2} \d{4}(?: [^)]*)?\)$/;

/** Strip anything that `normalizeVaultPath` would reject out of a device name. */
export function sanitizeDeviceName(name: string): string {
  const cleaned = name
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"|?*\\/\x00-\x1F\x7F()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32)
    .trim();
  return cleaned.length > 0 ? cleaned : 'device';
}

function twoDigit(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Local-time stamp, `YYYY-MM-DD HHMM`. Local rather than UTC because this
 * string is read by a human looking for "the version I wrote this morning".
 */
export function conflictStamp(when: Date): string {
  return (
    `${when.getFullYear()}-${twoDigit(when.getMonth() + 1)}-${twoDigit(when.getDate())}` +
    ` ${twoDigit(when.getHours())}${twoDigit(when.getMinutes())}`
  );
}

/**
 * Build the path for a conflict copy of `path`.
 *
 * The base name is truncated if the suffix would push the result past
 * `MAX_PATH_LENGTH`, so a deeply nested file can always still be saved.
 */
export function conflictPath(path: string, deviceName: string, when: Date): string {
  const normalized = normalizeVaultPath(path);
  const dir = dirname(normalized);
  const name = basename(normalized);
  const ext = extname(normalized);
  const base = ext === '' ? name : name.slice(0, -ext.length);
  const suffix = ` (conflict ${conflictStamp(when)} ${sanitizeDeviceName(deviceName)})`;

  const prefix = dir === '' ? '' : `${dir}/`;
  const room = MAX_PATH_LENGTH - prefix.length - suffix.length - ext.length;
  // Trailing dots and spaces are stripped again after truncation because
  // `normalizeVaultPath` rejects segments that end in either.
  const stem = base.slice(0, Math.max(1, room)).replace(/[. ]+$/, '') || 'note';

  return normalizeVaultPath(`${prefix}${stem}${suffix}${ext}`);
}

/** True if `path` looks like something `conflictPath` produced. */
export function isConflictPath(path: string): boolean {
  const ext = extname(path);
  const stem = ext === '' ? basename(path) : basename(path).slice(0, -ext.length);
  return CONFLICT_MARKER.test(stem);
}
