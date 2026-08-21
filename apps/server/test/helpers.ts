import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { HEADERS, sha256Hex } from '@obsidiansync/protocol';
import { buildApp } from '../src/app.js';
import { mintToken } from '../src/auth.js';
import { loadConfig, type ServerConfig } from '../src/config.js';
import { MetaDb } from '../src/db.js';
import { VaultStore } from '../src/store.js';

export interface Harness {
  app: FastifyInstance;
  db: MetaDb;
  store: VaultStore;
  config: ServerConfig;
  token: string;
  auth: { authorization: string };
  dispose: () => Promise<void>;
  /** Convenience: PUT `content` at `path` with the given base hash. */
  put: (path: string, content: string, baseHash?: string) => Promise<ReturnType<FastifyInstance['inject']>>;
  del: (path: string, baseHash: string) => Promise<ReturnType<FastifyInstance['inject']>>;
  get: (path: string) => Promise<ReturnType<FastifyInstance['inject']>>;
  hashOf: (content: string) => Promise<string>;
}

export async function createHarness(overrides: Partial<NodeJS.ProcessEnv> = {}): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), 'obsidiansync-test-'));
  const config = loadConfig({ DATA_DIR: dataDir, LOG_LEVEL: 'silent', ...overrides } as NodeJS.ProcessEnv);
  const db = new MetaDb(config.dbPath);
  const store = new VaultStore(config.vaultDir, config.trashDir);
  const app = await buildApp({ config, db, store });
  const { token } = await mintToken(db, 'test-device');
  const auth = { authorization: `Bearer ${token}` };

  return {
    app,
    db,
    store,
    config,
    token,
    auth,
    hashOf: (content: string) => sha256Hex(Buffer.from(content)),
    put: (path, content, baseHash = '') =>
      app.inject({
        method: 'PUT',
        url: `/v1/file?path=${encodeURIComponent(path)}`,
        headers: {
          ...auth,
          'content-type': 'application/octet-stream',
          [HEADERS.baseHash]: baseHash,
          [HEADERS.device]: 'test-device',
        },
        payload: Buffer.from(content),
      }),
    del: (path, baseHash) =>
      app.inject({
        method: 'DELETE',
        url: `/v1/file?path=${encodeURIComponent(path)}`,
        headers: { ...auth, [HEADERS.baseHash]: baseHash, [HEADERS.device]: 'test-device' },
      }),
    get: (path) =>
      app.inject({ method: 'GET', url: `/v1/file?path=${encodeURIComponent(path)}`, headers: auth }),
    dispose: async () => {
      await app.close();
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
