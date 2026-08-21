/**
 * Wire protocol shared by the sync server and the Obsidian plugin.
 *
 * Both sides import these definitions from this package so a change to the
 * protocol is a single edit that breaks compilation on whichever side has not
 * kept up, rather than a runtime mismatch discovered on a phone.
 */

/** Bumped on any breaking change to the routes or payloads below. */
export const PROTOCOL_VERSION = 1;

/** Server's view of a single path. `deleted` entries are tombstones. */
export interface FileMeta {
  path: string;
  /** Lowercase hex SHA-256 of the file bytes. Empty string for a tombstone. */
  hash: string;
  size: number;
  /**
   * Client-reported modification time, epoch milliseconds. For a tombstone
   * this is the time the delete was accepted. Used only to decide which side
   * of a conflict wins; never for change detection (hashes do that).
   */
  mtime: number;
  deleted: boolean;
  /** Global monotonic sequence number assigned when this change was accepted. */
  seq: number;
  /** Id of the device that made the change. */
  device: string;
}

/** One entry of a client's full-vault manifest, sent to `POST /v1/negotiate`. */
export interface ManifestEntry {
  path: string;
  hash: string;
  size: number;
  mtime: number;
  /**
   * The server hash this client last recorded for the path, if it has ever
   * been in sync. This is what makes negotiation a three-way comparison
   * instead of a two-way one: without it, a file the *server* changed while
   * this client sat idle is indistinguishable from a genuine divergence, and
   * every poll after a dropped cursor would manufacture conflict copies.
   * Absent on a device syncing for the first time.
   */
  baseHash?: string;
}

/**
 * An instruction from the server telling a client how to reconcile one path.
 * The client executes these verbatim; all the divergence reasoning lives
 * server-side so every device behaves identically.
 */
export type SyncAction =
  /** Server has content the client does not (or has an older copy of). */
  | { op: 'pull'; meta: FileMeta }
  /** Client has content the server has never seen. */
  | { op: 'push'; path: string }
  /** Server has a tombstone that the client has not applied yet. */
  | { op: 'delete-local'; meta: FileMeta }
  /** Both sides changed independently; resolve with a conflict copy. */
  | { op: 'conflict'; meta: FileMeta }
  /** Hashes already match; the client just records the server's seq. */
  | { op: 'in-sync'; meta: FileMeta };

export interface HelloRequest {
  protocol: number;
  deviceName: string;
  /** Omitted on a device's very first connection; the server mints one. */
  deviceId?: string;
}

export interface HelloResponse {
  protocol: number;
  /** Stable id for this server's vault; a client refuses to sync if it changes. */
  vaultId: string;
  serverSeq: number;
  deviceId: string;
  /** Largest body the server will accept, in bytes. */
  maxFileSize: number;
  serverVersion: string;
}

export interface NegotiateRequest {
  deviceId: string;
  files: ManifestEntry[];
}

export interface NegotiateResponse {
  serverSeq: number;
  actions: SyncAction[];
}

export interface ChangesResponse {
  changes: FileMeta[];
  /** Cursor to pass as `since` on the next poll. */
  seq: number;
  /** True when the page was truncated and another poll should follow immediately. */
  more: boolean;
}

export interface PutResponse {
  seq: number;
  hash: string;
}

/** Body of a 409, telling the client what the server actually holds. */
export interface ConflictResponse {
  error: 'conflict';
  server: FileMeta;
}

export interface MoveRequest {
  from: string;
  to: string;
  /** Hash the client believes the server holds at `from`. */
  baseHash: string;
  mtime: number;
}

export interface ErrorResponse {
  error: string;
  message: string;
}

/** Header names used to carry per-file metadata alongside raw bodies. */
export const HEADERS = {
  hash: 'x-hash',
  baseHash: 'x-base-hash',
  seq: 'x-seq',
  mtime: 'x-mtime',
  device: 'x-device',
} as const;
