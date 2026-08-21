import { buildApp, SERVER_VERSION } from './app.js';
import { mintToken } from './auth.js';
import { loadConfig } from './config.js';
import { MetaDb } from './db.js';
import { VaultStore } from './store.js';

/** How often to sweep expired tombstones and trashed content. */
const RETENTION_SWEEP_MS = 6 * 60 * 60 * 1000;

async function main(): Promise<void> {
  const config = loadConfig();
  const db = new MetaDb(config.dbPath);
  const store = new VaultStore(config.vaultDir, config.trashDir);
  const app = await buildApp({ config, db, store });

  // A fresh container has no tokens, and the operator may not want to exec in
  // just to mint the first one. BOOTSTRAP_TOKEN covers that, but only while no
  // token exists, so leaving it set does not create a permanent backdoor.
  if (config.bootstrapToken && db.countTokens() === 0) {
    await mintToken(db, 'bootstrap', config.bootstrapToken);
    app.log.warn('created the bootstrap token from BOOTSTRAP_TOKEN; unset it once devices are paired');
  }

  if (db.countTokens() === 0) {
    app.log.warn('no access tokens exist yet - run `node dist/cli.js token add <name>` to create one');
  }

  const sweep = async (): Promise<void> => {
    const cutoff = Date.now() - config.trashRetentionDays * 24 * 60 * 60 * 1000;
    try {
      const purgedTombstones = db.purgeTombstones(cutoff);
      const purgedTrash = await store.purgeTrash(cutoff);
      if (purgedTombstones.length > 0 || purgedTrash > 0) {
        app.log.info(
          { tombstones: purgedTombstones.length, trashSnapshots: purgedTrash },
          'retention sweep complete',
        );
      }
    } catch (error) {
      app.log.error({ err: error }, 'retention sweep failed');
    }
  };

  await sweep();
  const timer = setInterval(() => void sweep(), RETENTION_SWEEP_MS);
  // Do not hold the process open just for the sweep timer.
  timer.unref();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    clearInterval(timer);
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    { version: SERVER_VERSION, dataDir: config.dataDir, maxFileMb: config.maxFileSize / 1024 / 1024 },
    'obsidian sync server ready',
  );
}

main().catch((error: unknown) => {
  console.error('failed to start:', error);
  process.exit(1);
});
