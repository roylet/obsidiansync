/**
 * What this device believes it has already synced.
 *
 * For every path it holds the hash the file had when it last agreed with the
 * server. That single value is what turns "these two files differ" into
 * "which side changed" - without it the engine cannot tell an incoming edit
 * from a local one, and would have to treat every difference as a conflict.
 */

export interface SyncedRecord {
  /** Content hash at the moment client and server last agreed. */
  hash: string;
  size: number;
  mtime: number;
  /** Server seq that produced this state, for diagnostics. */
  seq: number;
}

export interface PersistedState {
  version: 1;
  /** Identifies this device to the server across restarts. */
  deviceId: string;
  /** Guards against pointing the same device at a different vault by mistake. */
  vaultId: string;
  /** Change-feed cursor. */
  lastSeq: number;
  records: Record<string, SyncedRecord>;
}

export function emptyState(): PersistedState {
  return { version: 1, deviceId: '', vaultId: '', lastSeq: 0, records: {} };
}

export class SyncState {
  private data: PersistedState;
  private dirty = false;

  constructor(initial: PersistedState = emptyState()) {
    this.data = initial;
  }

  static fromJson(raw: string | null | undefined): SyncState {
    if (!raw) return new SyncState();
    try {
      const parsed = JSON.parse(raw) as PersistedState;
      if (parsed?.version !== 1 || typeof parsed.records !== 'object' || parsed.records === null) {
        return new SyncState();
      }
      return new SyncState({ ...emptyState(), ...parsed });
    } catch {
      // A truncated state file costs one full re-scan, which is recoverable;
      // refusing to start would not be.
      return new SyncState();
    }
  }

  toJson(): string {
    return JSON.stringify(this.data);
  }

  get deviceId(): string {
    return this.data.deviceId;
  }
  get vaultId(): string {
    return this.data.vaultId;
  }
  get lastSeq(): number {
    return this.data.lastSeq;
  }
  get isDirty(): boolean {
    return this.dirty;
  }
  /** True before the first successful sync, when a full negotiation is needed. */
  get isEmpty(): boolean {
    return Object.keys(this.data.records).length === 0 && this.data.lastSeq === 0;
  }

  setIdentity(deviceId: string, vaultId: string): void {
    this.data.deviceId = deviceId;
    this.data.vaultId = vaultId;
    this.dirty = true;
  }

  setCursor(seq: number): void {
    // Never move the cursor backwards: an out-of-order response would
    // otherwise replay changes that have already been applied.
    if (seq > this.data.lastSeq) {
      this.data.lastSeq = seq;
      this.dirty = true;
    }
  }

  /** Forget the cursor so the next sync renegotiates from a full manifest. */
  resetCursor(): void {
    this.data.lastSeq = 0;
    this.dirty = true;
  }

  get(path: string): SyncedRecord | undefined {
    return this.data.records[path];
  }

  paths(): string[] {
    return Object.keys(this.data.records);
  }

  record(path: string, value: SyncedRecord): void {
    this.data.records[path] = value;
    this.dirty = true;
  }

  forget(path: string): void {
    if (path in this.data.records) {
      delete this.data.records[path];
      this.dirty = true;
    }
  }

  clearRecords(): void {
    this.data.records = {};
    this.dirty = true;
  }

  markClean(): void {
    this.dirty = false;
  }
}
