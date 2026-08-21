import { resolve } from 'node:path';

export interface ServerConfig {
  port: number;
  host: string;
  dataDir: string;
  vaultDir: string;
  trashDir: string;
  dbPath: string;
  /** Largest single file the server will accept, in bytes. */
  maxFileSize: number;
  /**
   * How long tombstones and trashed content are kept. A device that has been
   * offline longer than this cannot use its cursor and is sent through a full
   * manifest negotiation instead.
   */
  trashRetentionDays: number;
  /** Page size for the `/v1/changes` feed. */
  changesPageSize: number;
  logLevel: string;
  /**
   * Optional token minted on first start, so a fresh container is usable
   * without an exec into it. Ignored once any token exists.
   */
  bootstrapToken: string | undefined;
}

function intFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${key} must be a positive number, got ${JSON.stringify(raw)}`);
  }
  return Math.floor(value);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const dataDir = resolve(env.DATA_DIR ?? '/data');
  return {
    port: intFromEnv(env, 'PORT', 8080),
    // Binds all interfaces because the process only ever sees traffic from the
    // Cloudflare tunnel sidecar or the NAS's own docker network.
    host: env.HOST ?? '0.0.0.0',
    dataDir,
    vaultDir: resolve(dataDir, 'vault'),
    trashDir: resolve(dataDir, 'trash'),
    dbPath: resolve(dataDir, 'meta.db'),
    // Defaults to 100 MB: Cloudflare's free plan rejects larger request bodies,
    // so accepting more would only produce uploads that fail at the edge.
    maxFileSize: intFromEnv(env, 'MAX_FILE_MB', 100) * 1024 * 1024,
    trashRetentionDays: intFromEnv(env, 'TRASH_RETENTION_DAYS', 30),
    changesPageSize: intFromEnv(env, 'CHANGES_PAGE_SIZE', 500),
    logLevel: env.LOG_LEVEL ?? 'info',
    bootstrapToken: env.BOOTSTRAP_TOKEN?.trim() || undefined,
  };
}
