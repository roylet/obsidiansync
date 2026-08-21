/**
 * Admin CLI, run inside the container:
 *
 *   docker compose exec obsidian-sync node dist/cli.js token add "iPhone"
 *
 * Tokens are shown once at creation. Only their scrypt hash is stored, so a
 * lost token is replaced rather than recovered.
 */
import { mintToken } from './auth.js';
import { loadConfig } from './config.js';
import { MetaDb } from './db.js';

const USAGE = `Usage:
  node dist/cli.js token add <name>     mint a token for one device
  node dist/cli.js token list           list tokens (never shows the secret)
  node dist/cli.js token revoke <id>    revoke a token
  node dist/cli.js devices              list devices that have connected
  node dist/cli.js status               vault id, file count and current seq
`;

function formatDate(value: number | null): string {
  return value ? new Date(value).toISOString() : 'never';
}

async function main(): Promise<number> {
  const [group, action, ...rest] = process.argv.slice(2);
  const config = loadConfig();
  const db = new MetaDb(config.dbPath);

  try {
    if (group === 'token' && action === 'add') {
      const name = rest.join(' ').trim();
      if (!name) {
        console.error('a device name is required, e.g. token add "iPhone"');
        return 1;
      }
      const minted = await mintToken(db, name);
      console.log(`Created token for ${minted.name} (id ${minted.id}).`);
      console.log('Paste this into the plugin settings on that device:\n');
      console.log(`  ${minted.token}\n`);
      console.log('It will not be shown again.');
      return 0;
    }

    if (group === 'token' && action === 'list') {
      const tokens = db.listTokens();
      if (tokens.length === 0) {
        console.log('No tokens yet. Create one with: token add "<device name>"');
        return 0;
      }
      for (const token of tokens) {
        console.log(
          `${token.id}  ${token.name.padEnd(20)}  created ${formatDate(token.created)}  last used ${formatDate(token.last_seen)}`,
        );
      }
      return 0;
    }

    if (group === 'token' && action === 'revoke') {
      const id = rest[0];
      if (!id) {
        console.error('a token id is required; run `token list` to find it');
        return 1;
      }
      if (!db.deleteToken(id)) {
        console.error(`no token with id ${id}`);
        return 1;
      }
      console.log(`Revoked ${id}.`);
      return 0;
    }

    if (group === 'devices') {
      const devices = db.listDevices();
      if (devices.length === 0) {
        console.log('No devices have connected yet.');
        return 0;
      }
      for (const device of devices) {
        console.log(`${device.id}  ${device.name.padEnd(20)}  last seen ${formatDate(device.last_seen)}`);
      }
      return 0;
    }

    if (group === 'status') {
      const all = db.listAll();
      const live = all.filter((f) => f.deleted === 0);
      console.log(`vault id:   ${db.vaultId}`);
      console.log(`data dir:   ${config.dataDir}`);
      console.log(`files:      ${live.length} live, ${all.length - live.length} tombstoned`);
      console.log(`current seq:${db.currentSeq}`);
      console.log(`devices:    ${db.listDevices().length}`);
      return 0;
    }

    console.log(USAGE);
    return group === undefined ? 0 : 1;
  } finally {
    db.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
