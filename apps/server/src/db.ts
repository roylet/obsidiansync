import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FileMeta } from '@obsidiansync/protocol';

/**
 * Metadata store.
 *
 * The vault bytes live on disk as ordinary files (so the NAS copy is
 * browsable and backup-able); this database holds everything else: the
 * per-path hash index, the monotonic change feed every client polls, device
 * registrations and access tokens.
 */

export interface FileRow {
  path: string;
  hash: string;
  size: number;
  mtime: number;
  deleted: number;
  seq: number;
  device: string;
}

export interface TokenRow {
  id: string;
  name: string;
  hash: string;
  salt: string;
  created: number;
  last_seen: number | null;
}

export interface DeviceRow {
  id: string;
  name: string;
  token_id: string;
  last_seq: number;
  last_seen: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  path    TEXT PRIMARY KEY,
  hash    TEXT NOT NULL,
  size    INTEGER NOT NULL,
  mtime   INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  seq     INTEGER NOT NULL,
  device  TEXT NOT NULL
);
-- The changes feed is a range scan over seq, and it is the hottest query on
-- the server: every device polls it every few seconds.
CREATE INDEX IF NOT EXISTS files_seq ON files (seq);

CREATE TABLE IF NOT EXISTS tokens (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  hash      TEXT NOT NULL,
  salt      TEXT NOT NULL,
  created   INTEGER NOT NULL,
  last_seen INTEGER
);

CREATE TABLE IF NOT EXISTS devices (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  token_id  TEXT NOT NULL,
  last_seq  INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function rowToMeta(row: FileRow): FileMeta {
  return {
    path: row.path,
    hash: row.hash,
    size: row.size,
    mtime: row.mtime,
    deleted: row.deleted === 1,
    seq: row.seq,
    device: row.device,
  };
}

export class MetaDb {
  private readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    // WAL lets the polling reads run without blocking an in-flight upload.
    this.db.pragma('journal_mode = WAL');
    // FULL rather than NORMAL: this is somebody's only copy of their notes,
    // and a NAS loses power more often than a datacentre does.
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.initState();
  }

  private initState(): void {
    const insert = this.db.prepare('INSERT OR IGNORE INTO state (key, value) VALUES (?, ?)');
    insert.run('next_seq', '1');
    insert.run('vault_id', randomUUID());
  }

  close(): void {
    this.db.close();
  }

  /** Run `fn` inside a transaction; better-sqlite3 rolls back if it throws. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  getState(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM state WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setState(key: string, value: string): void {
    this.db.prepare('INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  get vaultId(): string {
    return this.getState('vault_id') ?? '';
  }

  /** Highest seq handed out so far. Clients use this as their cursor. */
  get currentSeq(): number {
    return Number(this.getState('next_seq') ?? '1') - 1;
  }

  /**
   * Claim the next sequence number. Must be called inside the same
   * transaction as the row write it labels, or a reader could observe a gap
   * and skip a change forever.
   */
  nextSeq(): number {
    const current = Number(this.getState('next_seq') ?? '1');
    this.setState('next_seq', String(current + 1));
    return current;
  }

  getFile(path: string): FileRow | undefined {
    return this.db.prepare('SELECT * FROM files WHERE path = ?').get(path) as FileRow | undefined;
  }

  /** Every live (non-tombstone) file, used to build a negotiation plan. */
  listLive(): FileRow[] {
    return this.db.prepare('SELECT * FROM files WHERE deleted = 0 ORDER BY path').all() as FileRow[];
  }

  listAll(): FileRow[] {
    return this.db.prepare('SELECT * FROM files ORDER BY path').all() as FileRow[];
  }

  changesSince(since: number, limit: number): FileRow[] {
    return this.db
      .prepare('SELECT * FROM files WHERE seq > ? ORDER BY seq LIMIT ?')
      .all(since, limit) as FileRow[];
  }

  upsertFile(row: FileRow): void {
    this.db
      .prepare(
        `INSERT INTO files (path, hash, size, mtime, deleted, seq, device)
         VALUES (@path, @hash, @size, @mtime, @deleted, @seq, @device)
         ON CONFLICT(path) DO UPDATE SET
           hash = excluded.hash, size = excluded.size, mtime = excluded.mtime,
           deleted = excluded.deleted, seq = excluded.seq, device = excluded.device`,
      )
      .run(row);
  }

  /**
   * Oldest tombstone still on record. A client whose cursor predates this may
   * have missed a delete that has since been purged, so it has to renegotiate
   * from a full manifest rather than trust its cursor.
   */
  oldestTombstoneSeq(): number | undefined {
    const row = this.db.prepare('SELECT MIN(seq) AS seq FROM files WHERE deleted = 1').get() as
      | { seq: number | null }
      | undefined;
    return row?.seq ?? undefined;
  }

  /** Drop tombstones older than `cutoff` (epoch ms). Returns the paths purged. */
  purgeTombstones(cutoff: number): string[] {
    const rows = this.db
      .prepare('SELECT path FROM files WHERE deleted = 1 AND mtime < ?')
      .all(cutoff) as { path: string }[];
    if (rows.length > 0) {
      this.db.prepare('DELETE FROM files WHERE deleted = 1 AND mtime < ?').run(cutoff);
    }
    return rows.map((r) => r.path);
  }

  // --- tokens ---------------------------------------------------------------

  insertToken(row: TokenRow): void {
    this.db
      .prepare(
        'INSERT INTO tokens (id, name, hash, salt, created, last_seen) VALUES (@id, @name, @hash, @salt, @created, @last_seen)',
      )
      .run(row);
  }

  listTokens(): TokenRow[] {
    return this.db.prepare('SELECT * FROM tokens ORDER BY created').all() as TokenRow[];
  }

  countTokens(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM tokens').get() as { n: number };
    return row.n;
  }

  deleteToken(id: string): boolean {
    return this.db.prepare('DELETE FROM tokens WHERE id = ?').run(id).changes > 0;
  }

  touchToken(id: string, when: number): void {
    this.db.prepare('UPDATE tokens SET last_seen = ? WHERE id = ?').run(when, id);
  }

  // --- devices --------------------------------------------------------------

  getDevice(id: string): DeviceRow | undefined {
    return this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as DeviceRow | undefined;
  }

  upsertDevice(row: DeviceRow): void {
    this.db
      .prepare(
        `INSERT INTO devices (id, name, token_id, last_seq, last_seen)
         VALUES (@id, @name, @token_id, @last_seq, @last_seen)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, token_id = excluded.token_id, last_seen = excluded.last_seen`,
      )
      .run(row);
  }

  listDevices(): DeviceRow[] {
    return this.db.prepare('SELECT * FROM devices ORDER BY last_seen DESC').all() as DeviceRow[];
  }
}
