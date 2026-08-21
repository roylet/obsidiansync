import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  HEADERS,
  InvalidPathError,
  normalizeVaultPath,
  PROTOCOL_VERSION,
  sha256Hex,
  type ChangesResponse,
  type FileMeta,
  type HelloRequest,
  type HelloResponse,
  type MoveRequest,
  type NegotiateRequest,
  type NegotiateResponse,
  type PutResponse,
} from '@obsidiansync/protocol';
import { randomUUID } from 'node:crypto';
import { AuthThrottle, parseBearer, verifyToken } from './auth.js';
import type { ServerConfig } from './config.js';
import { MetaDb, rowToMeta, type FileRow, type TokenRow } from './db.js';
import { buildNegotiationPlan } from './sync.js';
import { VaultStore } from './store.js';

export const SERVER_VERSION = '0.1.0';

declare module 'fastify' {
  interface FastifyRequest {
    token?: TokenRow;
  }
}

export interface AppDeps {
  config: ServerConfig;
  db: MetaDb;
  store: VaultStore;
}

/** Numeric header, or `fallback` when absent or malformed. */
function headerNumber(request: FastifyRequest, name: string, fallback: number): number {
  const raw = request.headers[name];
  const value = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function headerString(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

/** Read `?path=` and canonicalise it, replying 400 if it is not a legal path. */
function requirePath(request: FastifyRequest, reply: FastifyReply): string | undefined {
  const raw = (request.query as { path?: string }).path;
  if (typeof raw !== 'string' || raw === '') {
    reply.code(400).send({ error: 'bad_request', message: 'missing path parameter' });
    return undefined;
  }
  try {
    return normalizeVaultPath(raw);
  } catch (error) {
    const message = error instanceof InvalidPathError ? error.reason : 'invalid path';
    reply.code(400).send({ error: 'invalid_path', message });
    return undefined;
  }
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, db, store } = deps;
  await store.ensureDirs();

  const app = Fastify({
    logger: { level: config.logLevel },
    // Uploads arrive as raw bytes; this cap is the server's own guard, in
    // addition to whatever the tunnel in front of it enforces.
    bodyLimit: config.maxFileSize,
    trustProxy: true,
  });

  // Raw binary bodies. Registered for octet-stream and as the fallback so a
  // client that omits or misreports Content-Type still uploads correctly.
  const rawParser = (_req: FastifyRequest, body: Buffer, done: (e: Error | null, b: Buffer) => void) =>
    done(null, body);
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, rawParser);
  app.addContentTypeParser('*', { parseAs: 'buffer' }, rawParser);

  const throttle = new AuthThrottle();

  /**
   * Bearer auth for everything except `/v1/health`.
   *
   * Failures are throttled per source address because this endpoint is
   * reachable from the internet through the tunnel, and scrypt on an
   * attacker's schedule is both a guessing oracle and a CPU sink.
   */
  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/v1/health' || request.url === '/health') return;

    const source = request.ip;
    if (throttle.isBlocked(source)) {
      return reply
        .code(429)
        .send({ error: 'too_many_attempts', message: 'too many failed attempts, try again later' });
    }

    const presented = parseBearer(request.headers.authorization);
    if (!presented) {
      throttle.recordFailure(source);
      return reply.code(401).send({ error: 'unauthorized', message: 'missing bearer token' });
    }

    const token = await verifyToken(db, presented);
    if (!token) {
      throttle.recordFailure(source);
      return reply.code(401).send({ error: 'unauthorized', message: 'invalid token' });
    }

    throttle.recordSuccess(source);
    db.touchToken(token.id, Date.now());
    request.token = token;
  });

  app.get('/v1/health', async () => ({
    ok: true,
    protocol: PROTOCOL_VERSION,
    version: SERVER_VERSION,
  }));

  app.post('/v1/hello', async (request, reply) => {
    const body = request.body as HelloRequest | undefined;
    const name = typeof body?.deviceName === 'string' ? body.deviceName.slice(0, 64) : 'unnamed';
    if (body?.protocol !== undefined && body.protocol !== PROTOCOL_VERSION) {
      return reply.code(426).send({
        error: 'protocol_mismatch',
        message: `server speaks protocol ${PROTOCOL_VERSION}, client sent ${body.protocol}`,
      });
    }

    const deviceId = typeof body?.deviceId === 'string' && body.deviceId ? body.deviceId : randomUUID();
    const existing = db.getDevice(deviceId);
    db.upsertDevice({
      id: deviceId,
      name,
      token_id: request.token!.id,
      last_seq: existing?.last_seq ?? 0,
      last_seen: Date.now(),
    });

    const response: HelloResponse = {
      protocol: PROTOCOL_VERSION,
      vaultId: db.vaultId,
      serverSeq: db.currentSeq,
      deviceId,
      maxFileSize: config.maxFileSize,
      serverVersion: SERVER_VERSION,
    };
    return response;
  });

  app.post('/v1/negotiate', async (request, reply) => {
    const body = request.body as NegotiateRequest | undefined;
    if (!body || !Array.isArray(body.files)) {
      return reply.code(400).send({ error: 'bad_request', message: 'files array required' });
    }

    // Canonicalise client paths before comparing, so an NFD path from macOS
    // lines up with the NFC one the server stored.
    const manifest = [];
    for (const entry of body.files) {
      try {
        manifest.push({ ...entry, path: normalizeVaultPath(entry.path) });
      } catch {
        // A path this server could never have accepted; the client is told
        // about it separately when it tries to push.
      }
    }

    const serverFiles = db.listAll().map(rowToMeta);
    const response: NegotiateResponse = {
      serverSeq: db.currentSeq,
      actions: buildNegotiationPlan(serverFiles, manifest),
    };
    return response;
  });

  app.get('/v1/changes', async (request, reply) => {
    const query = request.query as { since?: string; limit?: string };
    const since = Number(query.since ?? 0);
    if (!Number.isFinite(since) || since < 0) {
      return reply.code(400).send({ error: 'bad_request', message: 'invalid since cursor' });
    }

    // A cursor older than the oldest surviving tombstone may have missed a
    // delete that has since been purged. Rather than silently resurrect files
    // on that device, send it back through a full negotiation.
    const oldest = db.oldestTombstoneSeq();
    if (since > 0 && oldest !== undefined && since < oldest - 1) {
      return reply.code(410).send({
        error: 'cursor_expired',
        message: 'cursor predates tombstone retention; renegotiate from a full manifest',
      });
    }

    const limit = Math.min(Number(query.limit ?? config.changesPageSize) || config.changesPageSize, 2000);
    const rows = db.changesSince(since, limit);
    const response: ChangesResponse = {
      changes: rows.map(rowToMeta),
      seq: rows.length > 0 ? rows[rows.length - 1]!.seq : since,
      more: rows.length === limit,
    };
    return response;
  });

  app.get('/v1/file', async (request, reply) => {
    const path = requirePath(request, reply);
    if (path === undefined) return reply;

    const row = db.getFile(path);
    if (!row || row.deleted === 1) {
      return reply.code(404).send({ error: 'not_found', message: 'no such file' });
    }
    if (!(await store.exists(path))) {
      request.log.error({ path }, 'metadata row has no file on disk');
      return reply.code(500).send({ error: 'missing_content', message: 'file content is missing' });
    }

    return reply
      .header(HEADERS.hash, row.hash)
      .header(HEADERS.seq, String(row.seq))
      .header(HEADERS.mtime, String(row.mtime))
      .header('content-type', 'application/octet-stream')
      .header('content-length', String(row.size))
      .send(store.createReadStream(path));
  });

  app.put('/v1/file', async (request, reply) => {
    const path = requirePath(request, reply);
    if (path === undefined) return reply;

    const body = request.body;
    if (!Buffer.isBuffer(body)) {
      return reply.code(400).send({ error: 'bad_request', message: 'expected a binary body' });
    }
    if (body.length > config.maxFileSize) {
      return reply.code(413).send({ error: 'too_large', message: 'file exceeds the server limit' });
    }

    const baseHash = headerString(request, HEADERS.baseHash) ?? '';
    const mtime = headerNumber(request, HEADERS.mtime, Date.now());
    const device = headerString(request, HEADERS.device) ?? 'unknown';
    const hash = await sha256Hex(body);

    return store.withLock(path, async () => {
      const current = db.getFile(path);
      const currentHash = current && current.deleted === 0 ? current.hash : '';

      if (currentHash !== baseHash) {
        // Somebody else wrote this path since the client last looked. The
        // client resolves it into a conflict copy; the server stays out of it.
        return reply.code(409).send({
          error: 'conflict',
          server: current
            ? rowToMeta(current)
            : ({ path, hash: '', size: 0, mtime: 0, deleted: true, seq: 0, device: '' } as FileMeta),
        });
      }

      // A no-op re-upload of identical bytes must not burn a seq, or every
      // device would be woken for a change that does not exist.
      if (current && current.deleted === 0 && current.hash === hash) {
        return reply.send({ seq: current.seq, hash } satisfies PutResponse);
      }

      if (current && current.deleted === 0) {
        await store.trash(path, db.currentSeq + 1);
      }
      await store.write(path, body);

      const seq = db.transaction(() => {
        const next = db.nextSeq();
        db.upsertFile({
          path,
          hash,
          size: body.length,
          mtime,
          deleted: 0,
          seq: next,
          device,
        });
        return next;
      });

      return reply.send({ seq, hash } satisfies PutResponse);
    });
  });

  app.delete('/v1/file', async (request, reply) => {
    const path = requirePath(request, reply);
    if (path === undefined) return reply;

    const baseHash = headerString(request, HEADERS.baseHash) ?? '';
    const device = headerString(request, HEADERS.device) ?? 'unknown';

    return store.withLock(path, async () => {
      const current = db.getFile(path);
      const currentHash = current && current.deleted === 0 ? current.hash : '';

      if (currentHash !== baseHash) {
        return reply.code(409).send({
          error: 'conflict',
          server: current
            ? rowToMeta(current)
            : ({ path, hash: '', size: 0, mtime: 0, deleted: true, seq: 0, device: '' } as FileMeta),
        });
      }

      if (!current || current.deleted === 1) {
        // Already gone. Report the existing tombstone so the client can move on.
        return reply.send({ seq: current?.seq ?? db.currentSeq, hash: '' } satisfies PutResponse);
      }

      const seq = db.currentSeq + 1;
      await store.trash(path, seq);

      const assigned = db.transaction(() => {
        const next = db.nextSeq();
        db.upsertFile({
          path,
          hash: '',
          size: 0,
          // The tombstone's mtime is the moment of deletion; retention and the
          // "resurrect or delete" decision both key off it.
          mtime: Date.now(),
          deleted: 1,
          seq: next,
          device,
        });
        return next;
      });

      return reply.send({ seq: assigned, hash: '' } satisfies PutResponse);
    });
  });

  app.post('/v1/move', async (request, reply) => {
    const body = request.body as MoveRequest | undefined;
    if (!body || typeof body.from !== 'string' || typeof body.to !== 'string') {
      return reply.code(400).send({ error: 'bad_request', message: 'from and to are required' });
    }

    let from: string;
    let to: string;
    try {
      from = normalizeVaultPath(body.from);
      to = normalizeVaultPath(body.to);
    } catch (error) {
      const message = error instanceof InvalidPathError ? error.reason : 'invalid path';
      return reply.code(400).send({ error: 'invalid_path', message });
    }

    // Lock both paths in a stable order so two devices renaming in opposite
    // directions cannot deadlock against each other.
    const [first, second] = from < to ? [from, to] : [to, from];
    return store.withLock(first, async () =>
      store.withLock(second, async () => {
        const source = db.getFile(from);
        if (!source || source.deleted === 1) {
          return reply.code(404).send({ error: 'not_found', message: 'source does not exist' });
        }
        if (source.hash !== (body.baseHash ?? '')) {
          return reply.code(409).send({ error: 'conflict', server: rowToMeta(source) });
        }

        const destination = db.getFile(to);
        if (destination && destination.deleted === 0) {
          return reply.code(409).send({ error: 'conflict', server: rowToMeta(destination) });
        }

        const content = await store.read(from);
        await store.write(to, content);
        await store.remove(from);

        const seqs = db.transaction(() => {
          const createSeq = db.nextSeq();
          db.upsertFile({
            path: to,
            hash: source.hash,
            size: source.size,
            mtime: body.mtime ?? Date.now(),
            deleted: 0,
            seq: createSeq,
            device: source.device,
          });
          const deleteSeq = db.nextSeq();
          db.upsertFile({
            path: from,
            hash: '',
            size: 0,
            mtime: Date.now(),
            deleted: 1,
            seq: deleteSeq,
            device: source.device,
          });
          return { createSeq, deleteSeq };
        });

        return reply.send(seqs);
      }),
    );
  });

  app.get('/v1/devices', async () => ({ devices: db.listDevices() }));

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof InvalidPathError) {
      return reply.code(400).send({ error: 'invalid_path', message: error.reason });
    }
    if ((error as { statusCode?: number }).statusCode === 413) {
      return reply.code(413).send({ error: 'too_large', message: 'file exceeds the server limit' });
    }
    request.log.error({ err: error }, 'request failed');
    return reply.code(500).send({ error: 'internal', message: 'internal server error' });
  });

  return app;
}
