import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { IgnoreOptions } from '@obsidiansync/protocol';
import { buildApp } from '../../apps/server/src/app.js';
import { mintToken } from '../../apps/server/src/auth.js';
import { loadConfig } from '../../apps/server/src/config.js';
import { MetaDb } from '../../apps/server/src/db.js';
import { VaultStore } from '../../apps/server/src/store.js';
import { SyncApi } from '../../apps/plugin/src/api.js';
import { SyncEngine, type SyncOutcome } from '../../apps/plugin/src/engine.js';
import type { HttpFn, SyncReporter } from '../../apps/plugin/src/ports.js';
import { SyncState } from '../../apps/plugin/src/state.js';
import { FakeVault } from '../../apps/plugin/test/fake-vault.js';

/**
 * A real server plus however many simulated devices a test needs.
 *
 * The devices run the actual plugin engine against the actual server; only two
 * things are faked, and both are the things a test cannot have: the filesystem
 * (in memory) and the network (fastify's `inject`, which dispatches straight
 * into the route handlers). Everything between - hashing, the base-hash
 * protocol, negotiation, conflict resolution - is production code.
 */

function toArrayBuffer(payload: Buffer): ArrayBuffer {
  return payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer;
}

/** Speaks the engine's HTTP port by dispatching into the server in-process. */
function injectHttp(app: FastifyInstance, token: string): HttpFn {
  return async (request) => {
    const response = await app.inject({
      method: request.method as 'GET',
      url: request.path,
      headers: { ...request.headers, authorization: `Bearer ${token}` },
      payload:
        request.body === undefined
          ? undefined
          : typeof request.body === 'string'
            ? request.body
            : Buffer.from(request.body),
    });

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(response.headers)) {
      headers[key.toLowerCase()] = String(value);
    }
    return { status: response.statusCode, headers, body: toArrayBuffer(response.rawPayload) };
  };
}

export interface DeviceOptions {
  name: string;
  seed?: Record<string, string>;
  syncConfig?: boolean;
  patterns?: string[];
}

export class Device {
  readonly vault: FakeVault;
  readonly state: SyncState;
  readonly engine: SyncEngine;
  readonly conflicts: { path: string; copyPath: string }[] = [];
  readonly errors: string[] = [];

  constructor(
    readonly name: string,
    app: FastifyInstance,
    token: string,
    options: DeviceOptions,
  ) {
    this.vault = new FakeVault(options.seed ?? {});
    this.state = new SyncState();

    const ignore: IgnoreOptions = {
      syncConfig: options.syncConfig ?? false,
      configDir: '.obsidian',
      pluginId: 'vault-relay',
      patterns: options.patterns ?? [],
    };

    const reporter: SyncReporter = {
      status: () => undefined,
      conflict: (path, copyPath) => this.conflicts.push({ path, copyPath }),
      error: (message) => this.errors.push(message),
      debug: () => undefined,
    };

    const api = new SyncApi(injectHttp(app, token), token, () => this.state.deviceId || this.name);
    this.engine = new SyncEngine({
      fs: this.vault,
      api,
      state: this.state,
      ignore,
      reporter,
      deviceName: options.name,
      // Conflict-copy names key off the device's own clock, so tests get
      // deterministic filenames.
      now: () => new Date(this.vault.now),
    });
  }

  /** Edit a file the way a user would, advancing the clock so it looks newer. */
  edit(path: string, content: string): void {
    this.vault.tick();
    this.vault.writeText(path, content);
    this.engine.markDirty(path);
  }

  delete(path: string): void {
    this.vault.tick();
    void this.vault.remove(path);
    this.engine.markDirty(path);
  }

  sync(fullScan = false): Promise<SyncOutcome> {
    return this.engine.sync(fullScan);
  }

  read(path: string): string | undefined {
    return this.vault.readText(path);
  }
}

export class E2EHarness {
  private constructor(
    readonly app: FastifyInstance,
    readonly db: MetaDb,
    readonly token: string,
    private readonly dataDir: string,
  ) {}

  static async create(env: Partial<NodeJS.ProcessEnv> = {}): Promise<E2EHarness> {
    const dataDir = mkdtempSync(join(tmpdir(), 'obsidiansync-e2e-'));
    const config = loadConfig({ DATA_DIR: dataDir, LOG_LEVEL: 'silent', ...env } as NodeJS.ProcessEnv);
    const db = new MetaDb(config.dbPath);
    const store = new VaultStore(config.vaultDir, config.trashDir);
    const app = await buildApp({ config, db, store });
    const { token } = await mintToken(db, 'e2e');
    return new E2EHarness(app, db, token, dataDir);
  }

  device(options: DeviceOptions): Device {
    return new Device(options.name, this.app, this.token, options);
  }

  /** Paths the server currently considers live, for cross-checking devices. */
  serverPaths(): string[] {
    return this.db
      .listLive()
      .map((f) => f.path)
      .sort();
  }

  async dispose(): Promise<void> {
    await this.app.close();
    this.db.close();
    rmSync(this.dataDir, { recursive: true, force: true });
  }
}
