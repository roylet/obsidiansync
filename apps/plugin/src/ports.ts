/**
 * The two seams between the sync engine and the outside world.
 *
 * The engine talks only to these interfaces, so the whole of it can be driven
 * in tests: a fake filesystem in memory, and an HTTP function that calls the
 * real server through `fastify.inject`. That matters here more than usual,
 * because the alternative way to test this code is to own four devices and
 * edit notes on them by hand.
 */

export interface FileStat {
  /** Epoch milliseconds. */
  mtime: number;
  size: number;
}

/** The subset of Obsidian's `DataAdapter` the engine needs. */
export interface VaultFs {
  /** Non-recursive, like the Obsidian adapter it wraps. Paths are full, not names. */
  list(dir: string): Promise<{ files: string[]; folders: string[] }>;
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<FileStat | null>;
  mkdir(path: string): Promise<void>;
  /**
   * Move to the vault's local trash rather than unlinking, so a delete that
   * arrives from another device is recoverable if it was a mistake.
   */
  trash(path: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface HttpRequest {
  method: string;
  /** Path and query, relative to the configured server URL. */
  path: string;
  headers: Record<string, string>;
  body?: ArrayBuffer | string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: ArrayBuffer;
}

/**
 * One HTTP round trip. In the plugin this wraps Obsidian's `requestUrl`, which
 * issues the request natively instead of through the webview - that is what
 * makes it work on iOS and Android without the server needing CORS headers.
 */
export type HttpFn = (request: HttpRequest) => Promise<HttpResponse>;

/** Somewhere to report progress and problems; the plugin wires this to notices. */
export interface SyncReporter {
  status(message: string): void;
  conflict(path: string, copyPath: string): void;
  error(message: string, error?: unknown): void;
  debug(message: string, detail?: unknown): void;
}

export const silentReporter: SyncReporter = {
  status: () => undefined,
  conflict: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};
