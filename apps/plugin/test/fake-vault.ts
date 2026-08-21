import type { FileStat, VaultFs } from '../src/ports.js';

/**
 * An in-memory stand-in for Obsidian's vault adapter.
 *
 * Lets the whole sync engine be driven without Obsidian running, which is the
 * only practical way to test four-platform behaviour: the alternative is
 * editing notes by hand on four devices and watching what happens.
 */
export class FakeVault implements VaultFs {
  private readonly files = new Map<string, { data: Uint8Array; mtime: number }>();
  private readonly folders = new Set<string>();
  /** Everything sent to `trash`, so tests can assert nothing was hard-deleted. */
  readonly trashed: string[] = [];
  private clock: number;

  constructor(seed: Record<string, string> = {}, startTime = 1_000_000) {
    this.clock = startTime;
    for (const [path, content] of Object.entries(seed)) this.writeText(path, content);
  }

  /** Advance the fake clock so a later write looks genuinely newer. */
  tick(ms = 1000): number {
    this.clock += ms;
    return this.clock;
  }

  get now(): number {
    return this.clock;
  }

  writeText(path: string, content: string, mtime?: number): void {
    this.ensureParents(path);
    this.files.set(path, { data: new TextEncoder().encode(content), mtime: mtime ?? this.clock });
  }

  readText(path: string): string | undefined {
    const file = this.files.get(path);
    return file ? new TextDecoder().decode(file.data) : undefined;
  }

  has(path: string): boolean {
    return this.files.has(path);
  }

  paths(): string[] {
    return [...this.files.keys()].sort();
  }

  private ensureParents(path: string): void {
    const parts = path.split('/');
    parts.pop();
    let current = '';
    for (const part of parts) {
      current = current === '' ? part : `${current}/${part}`;
      this.folders.add(current);
    }
  }

  // --- VaultFs --------------------------------------------------------------

  async list(dir: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = dir === '/' || dir === '' ? '' : `${dir}/`;
    const files: string[] = [];
    const folders = new Set<string>();

    for (const path of this.files.keys()) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) files.push(path);
      else folders.add(`${prefix}${rest.slice(0, slash)}`);
    }
    for (const folder of this.folders) {
      if (!folder.startsWith(prefix)) continue;
      const rest = folder.slice(prefix.length);
      if (rest !== '' && !rest.includes('/')) folders.add(folder);
    }
    return { files: files.sort(), folders: [...folders].sort() };
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const file = this.files.get(path);
    if (!file) throw new Error(`ENOENT: ${path}`);
    return file.data.slice().buffer;
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.ensureParents(path);
    this.files.set(path, { data: new Uint8Array(data.slice(0)), mtime: this.clock });
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path);
  }

  async stat(path: string): Promise<FileStat | null> {
    const file = this.files.get(path);
    return file ? { mtime: file.mtime, size: file.data.byteLength } : null;
  }

  async mkdir(path: string): Promise<void> {
    this.folders.add(path);
  }

  async trash(path: string): Promise<void> {
    this.trashed.push(path);
    this.files.delete(path);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
}
