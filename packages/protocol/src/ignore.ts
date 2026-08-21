/**
 * Which paths are in scope for sync.
 *
 * Shared by both sides: the client uses it to decide what to scan and upload,
 * and the server uses it to reject anything that slips through, so a buggy or
 * hostile client cannot push a `workspace.json` that would then be handed to
 * every other device.
 *
 * The glob dialect is deliberately tiny (no dependency, so the plugin bundle
 * stays small): `*` matches within one segment, `**` crosses segments, `?`
 * matches one non-separator character, and a trailing `/` means "this
 * directory and everything beneath it".
 */

export interface IgnoreOptions {
  /** Whether the user opted in to syncing the Obsidian config directory. */
  syncConfig: boolean;
  /** Usually `.obsidian`, but a vault can be configured to use another name. */
  configDir: string;
  /** This plugin's manifest id, so it never tries to sync its own state. */
  pluginId: string;
  /** Extra user-supplied glob patterns. */
  patterns?: string[];
}

/**
 * Ignored regardless of settings: version-control and sync-tool metadata,
 * OS junk files, and Obsidian's own local trash.
 */
export const ALWAYS_IGNORED: readonly string[] = [
  '.git/',
  '.trash/',
  '.stfolder/',
  '.stversions/',
  '**/.DS_Store',
  '**/Thumbs.db',
  '**/desktop.ini',
];

/**
 * Config files that describe *this device's* window layout. They are excluded
 * even when config sync is switched on, because a phone and a desktop rewrite
 * them constantly and in incompatible ways: syncing them produces a conflict
 * every few seconds and no useful result.
 */
export const DEVICE_LOCAL_CONFIG: readonly string[] = ['workspace.json', 'workspace-mobile.json'];

const globCache = new Map<string, RegExp>();

/** Compile one pattern of the dialect described above into an anchored regex. */
export function globToRegExp(pattern: string): RegExp {
  const cached = globCache.get(pattern);
  if (cached) return cached;

  // A trailing slash means "the directory and all its contents".
  const isDirPrefix = pattern.endsWith('/');
  const body = isDirPrefix ? pattern.slice(0, -1) : pattern;

  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === '*') {
      if (body[i + 1] === '*') {
        // `**/` should also match zero directories, so `**/x` matches `x`.
        if (body[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }

  const source = isDirPrefix ? `^${out}(?:/.*)?$` : `^${out}$`;
  // Case-insensitive: the same vault is used on case-sensitive Linux and
  // case-insensitive macOS/Windows, and `thumbs.db` should match either way.
  const regex = new RegExp(source, 'i');
  globCache.set(pattern, regex);
  return regex;
}

export function matchesGlob(path: string, pattern: string): boolean {
  return globToRegExp(pattern).test(path);
}

/** Every pattern that applies given the current settings, for display and tests. */
export function effectiveIgnorePatterns(options: IgnoreOptions): string[] {
  const { syncConfig, configDir, pluginId, patterns = [] } = options;
  const out = [...ALWAYS_IGNORED];

  if (syncConfig) {
    for (const name of DEVICE_LOCAL_CONFIG) out.push(`${configDir}/${name}`);
    // The plugin's own settings and sync state live here. Syncing them would
    // overwrite each device's server token and replay its cursor.
    out.push(`${configDir}/plugins/${pluginId}/`);
  } else {
    out.push(`${configDir}/`);
  }

  out.push(...patterns.map((p) => p.trim()).filter((p) => p.length > 0 && !p.startsWith('#')));
  return out;
}

export function isIgnored(path: string, options: IgnoreOptions): boolean {
  return effectiveIgnorePatterns(options).some((pattern) => matchesGlob(path, pattern));
}
