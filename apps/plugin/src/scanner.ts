import { isIgnored, isValidVaultPath, sha256Hex, type IgnoreOptions } from '@obsidiansync/protocol';
import type { VaultFs } from './ports.js';

export interface ScannedFile {
  path: string;
  hash: string;
  size: number;
  mtime: number;
}

export interface ScanResult {
  files: Map<string, ScannedFile>;
  /**
   * Paths skipped because they cannot be represented on every platform - a
   * name with a colon, say, which Windows cannot create. Surfaced to the user
   * rather than dropped silently, since the alternative is a file that never
   * syncs and never explains why.
   */
  skipped: string[];
}

/**
 * Walk the whole vault and hash everything in scope.
 *
 * Obsidian's adapter is used rather than `vault.getFiles()` because only the
 * adapter can see the config directory, and config sync is an option here.
 * The walk is breadth-first over `list`, which is non-recursive.
 */
export async function scanVault(fs: VaultFs, ignore: IgnoreOptions): Promise<ScanResult> {
  const files = new Map<string, ScannedFile>();
  const skipped: string[] = [];
  const queue: string[] = ['/'];

  while (queue.length > 0) {
    const dir = queue.shift()!;
    let listing: { files: string[]; folders: string[] };
    try {
      listing = await fs.list(dir);
    } catch {
      // A folder that vanished mid-scan, or one the OS will not let us read.
      continue;
    }

    for (const folder of listing.folders) {
      // Prune whole ignored subtrees rather than walking into them: skipping
      // `.git` matters for both speed and correctness.
      if (!isIgnored(folder, ignore)) queue.push(folder);
    }

    for (const path of listing.files) {
      if (isIgnored(path, ignore)) continue;
      if (!isValidVaultPath(path)) {
        skipped.push(path);
        continue;
      }
      try {
        const content = await fs.readBinary(path);
        const stat = await fs.stat(path);
        files.set(path, {
          path,
          hash: await sha256Hex(content),
          size: content.byteLength,
          mtime: stat?.mtime ?? Date.now(),
        });
      } catch {
        // Deleted between listing and reading; the next scan will settle it.
      }
    }
  }

  return { files, skipped };
}

/** Hash one file, or `undefined` if it is gone. */
export async function hashFile(fs: VaultFs, path: string): Promise<ScannedFile | undefined> {
  try {
    const content = await fs.readBinary(path);
    const stat = await fs.stat(path);
    return {
      path,
      hash: await sha256Hex(content),
      size: content.byteLength,
      mtime: stat?.mtime ?? Date.now(),
    };
  } catch {
    return undefined;
  }
}
