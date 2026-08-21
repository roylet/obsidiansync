import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { normalizeVaultPath } from '@obsidiansync/protocol';

/**
 * The on-disk vault copy.
 *
 * Files are stored at their real relative paths under `vaultDir`, so the
 * directory the NAS backs up is just a normal Obsidian vault that can be
 * opened directly or restored with a file copy. Overwritten and deleted
 * content is moved into `trashDir` rather than unlinked, so a bad sync is
 * recoverable.
 */
export class VaultStore {
  /**
   * One promise chain per path. Two devices uploading the same note at the
   * same moment must not interleave read-modify-write against the metadata
   * row, and the second must see the first's hash so its base-hash check can
   * correctly report a conflict.
   */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly vaultDir: string,
    private readonly trashDir: string,
  ) {}

  /**
   * Map a vault-relative path onto a real one, refusing anything that escapes
   * the vault root.
   *
   * `normalizeVaultPath` already rejects traversal, but this re-checks the
   * resolved result: it is the last line of defence before a filesystem call,
   * and the cost of being wrong here is arbitrary file write.
   */
  realPath(vaultPath: string): string {
    const normalized = normalizeVaultPath(vaultPath);
    const full = resolve(this.vaultDir, normalized);
    const root = resolve(this.vaultDir);
    if (full !== root && !full.startsWith(root + sep)) {
      throw new Error(`path escapes the vault root: ${vaultPath}`);
    }
    return full;
  }

  /** Serialise all work touching `path`, in submission order. */
  async withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(path) ?? Promise.resolve();
    // Swallow the predecessor's rejection: one failed upload must not cascade
    // into every later request for the same path.
    const run = previous.catch(() => undefined).then(fn);
    this.locks.set(path, run);
    try {
      return await run;
    } finally {
      // Only clear if nobody queued behind us in the meantime.
      if (this.locks.get(path) === run) this.locks.delete(path);
    }
  }

  async read(vaultPath: string): Promise<Buffer> {
    return readFile(this.realPath(vaultPath));
  }

  createReadStream(vaultPath: string): NodeJS.ReadableStream {
    return createReadStream(this.realPath(vaultPath));
  }

  async exists(vaultPath: string): Promise<boolean> {
    try {
      await stat(this.realPath(vaultPath));
      return true;
    } catch {
      return false;
    }
  }

  async size(vaultPath: string): Promise<number | undefined> {
    try {
      return (await stat(this.realPath(vaultPath))).size;
    } catch {
      return undefined;
    }
  }

  /**
   * Write `data` at `vaultPath` atomically.
   *
   * The temp file is created in the destination directory so the final
   * `rename` stays within one filesystem and is therefore atomic: a reader
   * either sees the old file or the new one, never a half-written note.
   */
  async write(vaultPath: string, data: Buffer): Promise<void> {
    const full = this.realPath(vaultPath);
    await mkdir(dirname(full), { recursive: true });
    const tmp = `${full}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, data);
      await rename(tmp, full);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Move the current content of `vaultPath` into the trash, keyed by the seq
   * of the change that displaced it. Structure is preserved, so recovery is
   * `cp -r trash/<seq>/<path> vault/<path>`.
   */
  async trash(vaultPath: string, seq: number): Promise<void> {
    const source = this.realPath(vaultPath);
    if (!(await this.exists(vaultPath))) return;
    const destination = join(this.trashDir, String(seq), normalizeVaultPath(vaultPath));
    await mkdir(dirname(destination), { recursive: true });
    try {
      await rename(source, destination);
    } catch (error) {
      // Cross-device rename (a bind-mounted vault) needs a copy instead.
      if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
        await writeFile(destination, await readFile(source));
        await rm(source, { force: true });
      } else {
        throw error;
      }
    }
    await this.pruneEmptyParents(dirname(source));
  }

  async remove(vaultPath: string): Promise<void> {
    const full = this.realPath(vaultPath);
    await rm(full, { force: true });
    await this.pruneEmptyParents(dirname(full));
  }

  /**
   * Remove directories left empty by a delete, so the vault copy does not
   * accumulate empty folders that then sync back to every device.
   */
  private async pruneEmptyParents(startDir: string): Promise<void> {
    const root = resolve(this.vaultDir);
    let current = resolve(startDir);
    while (current !== root && current.startsWith(root + sep)) {
      try {
        const entries = await readdir(current);
        if (entries.length > 0) return;
        await rm(current, { recursive: false, force: true });
      } catch {
        return;
      }
      current = dirname(current);
    }
  }

  /** Delete trashed snapshots whose directory is older than `cutoff` (epoch ms). */
  async purgeTrash(cutoff: number): Promise<number> {
    let purged = 0;
    let entries: string[];
    try {
      entries = await readdir(this.trashDir);
    } catch {
      return 0;
    }
    for (const entry of entries) {
      const full = join(this.trashDir, entry);
      try {
        const info = await stat(full);
        if (info.mtimeMs < cutoff) {
          await rm(full, { recursive: true, force: true });
          purged += 1;
        }
      } catch {
        // Raced with another purge; nothing to do.
      }
    }
    return purged;
  }

  async ensureDirs(): Promise<void> {
    await mkdir(this.vaultDir, { recursive: true });
    await mkdir(this.trashDir, { recursive: true });
  }
}
