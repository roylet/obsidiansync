import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HEADERS, PROTOCOL_VERSION } from '@obsidiansync/protocol';
import { createHarness, type Harness } from './helpers.js';

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.dispose();
});

describe('authentication', () => {
  it('serves health without a token, so the tunnel can probe it', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/v1/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, protocol: PROTOCOL_VERSION });
  });

  it('rejects requests with no token', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/v1/changes?since=0' });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a wrong token', async () => {
    const response = await h.app.inject({
      method: 'GET',
      url: '/v1/changes?since=0',
      headers: { authorization: 'Bearer not-the-real-token' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('accepts the minted token', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/v1/changes?since=0', headers: h.auth });
    expect(response.statusCode).toBe(200);
  });

  it('throttles an address after repeated failures', async () => {
    for (let i = 0; i < 10; i++) {
      await h.app.inject({
        method: 'GET',
        url: '/v1/changes?since=0',
        headers: { authorization: 'Bearer wrong' },
      });
    }
    const blocked = await h.app.inject({
      method: 'GET',
      url: '/v1/changes?since=0',
      headers: { authorization: 'Bearer wrong' },
    });
    expect(blocked.statusCode).toBe(429);
  });
});

describe('hello', () => {
  it('mints a device id and reports server capabilities', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/v1/hello',
      headers: h.auth,
      payload: { protocol: PROTOCOL_VERSION, deviceName: 'iPhone' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.deviceId).toBeTruthy();
    expect(body.vaultId).toBeTruthy();
    expect(body.maxFileSize).toBe(100 * 1024 * 1024);
  });

  it('refuses a client speaking a different protocol version', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/v1/hello',
      headers: h.auth,
      payload: { protocol: PROTOCOL_VERSION + 1, deviceName: 'FromTheFuture' },
    });
    expect(response.statusCode).toBe(426);
  });

  it('keeps the same device id across reconnections', async () => {
    const first = await h.app.inject({
      method: 'POST',
      url: '/v1/hello',
      headers: h.auth,
      payload: { protocol: PROTOCOL_VERSION, deviceName: 'iPhone' },
    });
    const deviceId = first.json().deviceId;
    const second = await h.app.inject({
      method: 'POST',
      url: '/v1/hello',
      headers: h.auth,
      payload: { protocol: PROTOCOL_VERSION, deviceName: 'iPhone', deviceId },
    });
    expect(second.json().deviceId).toBe(deviceId);
  });
});

describe('upload and download', () => {
  it('stores a file and returns it byte-for-byte', async () => {
    const put = await h.put('notes/hello.md', '# Hello');
    expect(put.statusCode).toBe(200);
    expect(put.json().seq).toBe(1);

    const get = await h.get('notes/hello.md');
    expect(get.statusCode).toBe(200);
    expect(get.body).toBe('# Hello');
    expect(get.headers[HEADERS.hash]).toBe(await h.hashOf('# Hello'));
  });

  it('writes the file to the vault directory as a real, browsable file', async () => {
    await h.put('notes/deep/nested.md', 'content');
    const onDisk = readFileSync(join(h.config.vaultDir, 'notes/deep/nested.md'), 'utf8');
    expect(onDisk).toBe('content');
  });

  it('round-trips binary content without corruption', async () => {
    const bytes = Buffer.from([0x00, 0xff, 0x1f, 0x80, 0x0a, 0x0d]);
    const put = await h.app.inject({
      method: 'PUT',
      url: '/v1/file?path=attachments/blob.bin',
      headers: { ...h.auth, 'content-type': 'application/octet-stream', [HEADERS.baseHash]: '' },
      payload: bytes,
    });
    expect(put.statusCode).toBe(200);
    const get = await h.get('attachments/blob.bin');
    expect(Buffer.from(get.rawPayload).equals(bytes)).toBe(true);
  });

  it('404s for a file that does not exist', async () => {
    expect((await h.get('nope.md')).statusCode).toBe(404);
  });

  it('assigns strictly increasing sequence numbers', async () => {
    const a = await h.put('a.md', 'one');
    const b = await h.put('b.md', 'two');
    const c = await h.put('a.md', 'one-updated', await h.hashOf('one'));
    expect(a.json().seq).toBeLessThan(b.json().seq);
    expect(b.json().seq).toBeLessThan(c.json().seq);
  });

  it('does not burn a sequence number re-uploading identical bytes', async () => {
    const first = await h.put('a.md', 'same');
    const again = await h.put('a.md', 'same', await h.hashOf('same'));
    expect(again.statusCode).toBe(200);
    expect(again.json().seq).toBe(first.json().seq);
    expect(h.db.currentSeq).toBe(first.json().seq);
  });
});

describe('optimistic concurrency', () => {
  it('409s when the base hash does not match what the server holds', async () => {
    await h.put('note.md', 'server version');
    const stale = await h.put('note.md', 'my version', await h.hashOf('something else'));
    expect(stale.statusCode).toBe(409);
    expect(stale.json().server.hash).toBe(await h.hashOf('server version'));
  });

  it('409s when creating a file that already exists', async () => {
    await h.put('note.md', 'first');
    const second = await h.put('note.md', 'second', '');
    expect(second.statusCode).toBe(409);
  });

  it('accepts an update that names the current hash as its base', async () => {
    await h.put('note.md', 'v1');
    const update = await h.put('note.md', 'v2', await h.hashOf('v1'));
    expect(update.statusCode).toBe(200);
    expect((await h.get('note.md')).body).toBe('v2');
  });

  it('serialises concurrent writes to the same path so exactly one wins', async () => {
    await h.put('note.md', 'base');
    const base = await h.hashOf('base');
    const [first, second] = await Promise.all([
      h.put('note.md', 'from device A', base),
      h.put('note.md', 'from device B', base),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([200, 409]);
  });
});

describe('deletes and tombstones', () => {
  it('deletes a file and reports it as a tombstone in the change feed', async () => {
    await h.put('note.md', 'content');
    const removed = await h.del('note.md', await h.hashOf('content'));
    expect(removed.statusCode).toBe(200);
    expect((await h.get('note.md')).statusCode).toBe(404);

    const changes = await h.app.inject({ method: 'GET', url: '/v1/changes?since=0', headers: h.auth });
    const tombstone = changes.json().changes.find((c: { path: string }) => c.path === 'note.md');
    expect(tombstone.deleted).toBe(true);
  });

  it('409s on a delete with a stale base hash', async () => {
    await h.put('note.md', 'v1');
    await h.put('note.md', 'v2', await h.hashOf('v1'));
    const stale = await h.del('note.md', await h.hashOf('v1'));
    expect(stale.statusCode).toBe(409);
  });

  it('keeps the deleted content in the trash directory for recovery', async () => {
    await h.put('note.md', 'precious');
    const removed = await h.del('note.md', await h.hashOf('precious'));
    const seq = removed.json().seq;
    const recovered = readFileSync(join(h.config.trashDir, String(seq), 'note.md'), 'utf8');
    expect(recovered).toBe('precious');
  });

  it('keeps the overwritten version when a file is updated', async () => {
    await h.put('note.md', 'original');
    await h.put('note.md', 'replacement', await h.hashOf('original'));
    const snapshots = readFileSync(join(h.config.trashDir, '2', 'note.md'), 'utf8');
    expect(snapshots).toBe('original');
  });

  it('is idempotent when deleting something already gone', async () => {
    await h.put('note.md', 'content');
    await h.del('note.md', await h.hashOf('content'));
    const again = await h.del('note.md', '');
    expect(again.statusCode).toBe(200);
  });
});

describe('change feed', () => {
  it('returns only changes after the cursor', async () => {
    await h.put('a.md', '1');
    const afterFirst = h.db.currentSeq;
    await h.put('b.md', '2');

    const response = await h.app.inject({
      method: 'GET',
      url: `/v1/changes?since=${afterFirst}`,
      headers: h.auth,
    });
    const paths = response.json().changes.map((c: { path: string }) => c.path);
    expect(paths).toEqual(['b.md']);
  });

  it('paginates and signals that more remain', async () => {
    for (let i = 0; i < 5; i++) await h.put(`note-${i}.md`, `body ${i}`);
    const page = await h.app.inject({ method: 'GET', url: '/v1/changes?since=0&limit=2', headers: h.auth });
    expect(page.json().changes).toHaveLength(2);
    expect(page.json().more).toBe(true);

    const rest = await h.app.inject({
      method: 'GET',
      url: `/v1/changes?since=${page.json().seq}&limit=10`,
      headers: h.auth,
    });
    expect(rest.json().changes).toHaveLength(3);
    expect(rest.json().more).toBe(false);
  });

  it('410s a cursor that predates the retained tombstones', async () => {
    // Build history, delete something, then purge the tombstone as the
    // retention sweep eventually would.
    await h.put('a.md', '1');
    await h.put('b.md', '2');
    await h.del('a.md', await h.hashOf('1'));
    await h.put('c.md', '3');
    h.db.purgeTombstones(Date.now() + 1000);
    await h.put('d.md', '4');
    // A device still sitting at seq 1 could not learn about a.md's deletion.
    await h.del('c.md', await h.hashOf('3'));

    const expired = await h.app.inject({ method: 'GET', url: '/v1/changes?since=1', headers: h.auth });
    expect(expired.statusCode).toBe(410);
    expect(expired.json().error).toBe('cursor_expired');
  });

  it('accepts a fresh cursor even after a purge', async () => {
    await h.put('a.md', '1');
    const response = await h.app.inject({
      method: 'GET',
      url: `/v1/changes?since=${h.db.currentSeq}`,
      headers: h.auth,
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('path safety', () => {
  const traversals = ['../escape.md', 'notes/../../etc/passwd', 'a\\..\\b.md', 'notes/./x.md'];

  for (const bad of traversals) {
    it(`rejects ${JSON.stringify(bad)} on upload`, async () => {
      const response = await h.put(bad, 'payload');
      expect(response.statusCode).toBe(400);
    });

    it(`rejects ${JSON.stringify(bad)} on download`, async () => {
      const response = await h.get(bad);
      expect(response.statusCode).toBe(400);
    });
  }

  it('treats a leading slash as vault-relative rather than absolute', async () => {
    // Not a traversal: the slash is stripped, so this lands inside the vault
    // at `etc/passwd` and cannot reach the real one.
    const response = await h.put('/etc/passwd', 'harmless');
    expect(response.statusCode).toBe(200);
    expect(h.db.listLive().map((f) => f.path)).toEqual(['etc/passwd']);
    expect(readFileSync(join(h.config.vaultDir, 'etc/passwd'), 'utf8')).toBe('harmless');
  });

  it('rejects a missing path parameter', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/v1/file', headers: h.auth });
    expect(response.statusCode).toBe(400);
  });

  it('canonicalises NFD paths so macOS and Windows agree on one file', async () => {
    const nfd = 'notes/cafe\u0301.md'; // decomposed, as macOS reports it
    const nfc = 'notes/caf\u00e9.md'; // composed, as Windows and Linux report it
    expect(nfd).not.toBe(nfc);
    await h.put(nfd, 'content');
    const viaNfc = await h.get(nfc);
    expect(viaNfc.statusCode).toBe(200);
    expect(viaNfc.body).toBe('content');
    expect(h.db.listLive().map((f) => f.path)).toEqual([nfc]);
  });

  it('rejects a file larger than the configured limit', async () => {
    const small = await createHarness({ MAX_FILE_MB: '1' });
    try {
      const response = await small.app.inject({
        method: 'PUT',
        url: '/v1/file?path=big.bin',
        headers: { ...small.auth, 'content-type': 'application/octet-stream', [HEADERS.baseHash]: '' },
        payload: Buffer.alloc(2 * 1024 * 1024),
      });
      expect(response.statusCode).toBe(413);
    } finally {
      await small.dispose();
    }
  });
});

describe('move', () => {
  it('renames a file, creating the destination and tombstoning the source', async () => {
    await h.put('old.md', 'content');
    const response = await h.app.inject({
      method: 'POST',
      url: '/v1/move',
      headers: h.auth,
      payload: { from: 'old.md', to: 'new.md', baseHash: await h.hashOf('content'), mtime: Date.now() },
    });
    expect(response.statusCode).toBe(200);
    expect((await h.get('new.md')).body).toBe('content');
    expect((await h.get('old.md')).statusCode).toBe(404);
  });

  it('409s when the destination is occupied', async () => {
    await h.put('old.md', 'a');
    await h.put('new.md', 'b');
    const response = await h.app.inject({
      method: 'POST',
      url: '/v1/move',
      headers: h.auth,
      payload: { from: 'old.md', to: 'new.md', baseHash: await h.hashOf('a'), mtime: Date.now() },
    });
    expect(response.statusCode).toBe(409);
  });

  it('404s when the source is gone', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/v1/move',
      headers: h.auth,
      payload: { from: 'ghost.md', to: 'new.md', baseHash: '', mtime: Date.now() },
    });
    expect(response.statusCode).toBe(404);
  });
});
