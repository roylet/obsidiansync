/**
 * Vault path rules, shared so the client and server agree byte-for-byte on
 * what a path is before it is ever used to touch a filesystem.
 *
 * Two problems drive this module:
 *
 *  1. Traversal. The server turns these strings into real filesystem paths,
 *     so anything that can escape the vault root has to die here.
 *  2. Cross-platform portability. macOS hands back filenames in Unicode NFD
 *     while Windows and Linux use NFC, so `café.md` created on a Mac would
 *     otherwise sync as a second, distinct file everywhere else. Every path is
 *     normalised to NFC on the way in.
 */

/** Kept well under filesystem limits so conflict suffixes always still fit. */
export const MAX_PATH_LENGTH = 900;

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * Characters that are illegal in a filename on Windows, hostile on macOS, or
 * capable of confusing a path parser. Backslash is included because Obsidian
 * always reports paths with forward slashes, so a backslash can only be an
 * attempt to smuggle a separator past the segment checks below.
 */
// eslint-disable-next-line no-control-regex
const ILLEGAL_CHARS = /[<>:"|?*\\\x00-\x1F\x7F]/;

export class InvalidPathError extends Error {
  constructor(
    public readonly path: string,
    public readonly reason: string,
  ) {
    super(`invalid vault path ${JSON.stringify(path)}: ${reason}`);
    this.name = 'InvalidPathError';
  }
}

/**
 * Canonicalise a vault-relative path, or throw `InvalidPathError`.
 *
 * Collapses duplicate separators, strips leading and trailing separators, and
 * normalises to NFC. Rejects absolute paths, `.`/`..` segments, backslashes,
 * control characters, Windows-reserved device names, and segments ending in a
 * dot or space (which Windows silently truncates).
 */
export function normalizeVaultPath(input: string): string {
  if (typeof input !== 'string') throw new InvalidPathError(String(input), 'not a string');

  const nfc = input.normalize('NFC');
  if (nfc.length === 0) throw new InvalidPathError(input, 'empty');
  if (ILLEGAL_CHARS.test(nfc)) throw new InvalidPathError(input, 'contains an illegal character');
  // A Windows drive letter would be read as absolute by the server's path join.
  if (/^[a-z]:/i.test(nfc)) throw new InvalidPathError(input, 'absolute path');

  const segments: string[] = [];
  for (const segment of nfc.split('/')) {
    if (segment === '') continue; // collapses `//`, leading and trailing `/`
    if (segment === '.' || segment === '..') {
      throw new InvalidPathError(input, 'contains a relative segment');
    }
    if (segment.endsWith('.') || segment.endsWith(' ')) {
      throw new InvalidPathError(input, 'segment ends with a dot or space');
    }
    if (WINDOWS_RESERVED.test(segment)) {
      throw new InvalidPathError(input, `"${segment}" is a reserved name on Windows`);
    }
    segments.push(segment);
  }

  if (segments.length === 0) throw new InvalidPathError(input, 'empty after normalisation');
  const normalized = segments.join('/');
  if (normalized.length > MAX_PATH_LENGTH) throw new InvalidPathError(input, 'too long');
  return normalized;
}

/** Non-throwing form, for filtering a scan without aborting it. */
export function isValidVaultPath(input: string): boolean {
  try {
    normalizeVaultPath(input);
    return true;
  } catch {
    return false;
  }
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

export function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/**
 * Extension including the leading dot, or `''`. A leading dot on the filename
 * itself is part of the name (`.gitignore` has no extension).
 */
export function extname(path: string): string {
  const base = basename(path);
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i);
}

/**
 * Every ancestor directory of `path`, outermost first, so a client can create
 * them in order before writing the file.
 */
export function ancestorDirs(path: string): string[] {
  const parts = path.split('/');
  parts.pop();
  const out: string[] = [];
  let current = '';
  for (const part of parts) {
    current = current === '' ? part : `${current}/${part}`;
    out.push(current);
  }
  return out;
}
