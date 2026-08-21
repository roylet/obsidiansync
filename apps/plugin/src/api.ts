import {
  HEADERS,
  PROTOCOL_VERSION,
  type ChangesResponse,
  type FileMeta,
  type HelloResponse,
  type ManifestEntry,
  type NegotiateResponse,
  type PutResponse,
} from '@obsidiansync/protocol';
import type { HttpFn, HttpRequest } from './ports.js';

/** Thrown for anything the caller is not expected to handle inline. */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The server holds something different from what the caller assumed. */
export class ConflictError extends Error {
  constructor(public readonly server: FileMeta) {
    super(`conflict at ${server.path}`);
    this.name = 'ConflictError';
  }
}

/** The client's cursor is too old to be trusted; renegotiate from a manifest. */
export class CursorExpiredError extends Error {
  constructor() {
    super('sync cursor expired');
    this.name = 'CursorExpiredError';
  }
}

const decoder = new TextDecoder();

function decodeJson<T>(response: { body: ArrayBuffer }): T {
  const text = decoder.decode(response.body);
  return text === '' ? ({} as T) : (JSON.parse(text) as T);
}

export class SyncApi {
  constructor(
    private readonly http: HttpFn,
    private readonly token: string,
    private readonly deviceId: () => string,
  ) {}

  private async send(request: Omit<HttpRequest, 'headers'> & { headers?: Record<string, string> }) {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      ...request.headers,
    };
    const response = await this.http({ ...request, headers });

    if (response.status === 401) {
      throw new ApiError('The server rejected this token. Check the plugin settings.', 401, 'unauthorized');
    }
    if (response.status === 429) {
      throw new ApiError('Too many failed attempts. Wait a few minutes and try again.', 429, 'throttled');
    }
    if (response.status === 426) {
      throw new ApiError(
        'This plugin and the server speak different protocol versions. Update whichever is older.',
        426,
        'protocol_mismatch',
      );
    }
    return response;
  }

  async hello(deviceName: string, knownDeviceId?: string): Promise<HelloResponse> {
    const response = await this.send({
      method: 'POST',
      path: '/v1/hello',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: PROTOCOL_VERSION, deviceName, deviceId: knownDeviceId }),
    });
    if (response.status !== 200) {
      throw new ApiError(`Handshake failed (HTTP ${response.status}).`, response.status);
    }
    return decodeJson<HelloResponse>(response);
  }

  async negotiate(files: ManifestEntry[]): Promise<NegotiateResponse> {
    const response = await this.send({
      method: 'POST',
      path: '/v1/negotiate',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: this.deviceId(), files }),
    });
    if (response.status !== 200) {
      throw new ApiError(`Negotiation failed (HTTP ${response.status}).`, response.status);
    }
    return decodeJson<NegotiateResponse>(response);
  }

  async changes(since: number, limit?: number): Promise<ChangesResponse> {
    const query = limit === undefined ? `since=${since}` : `since=${since}&limit=${limit}`;
    const response = await this.send({ method: 'GET', path: `/v1/changes?${query}` });
    if (response.status === 410) throw new CursorExpiredError();
    if (response.status !== 200) {
      throw new ApiError(`Could not fetch changes (HTTP ${response.status}).`, response.status);
    }
    return decodeJson<ChangesResponse>(response);
  }

  /** Returns the bytes and the hash the server reports for them. */
  async getFile(path: string): Promise<{ content: ArrayBuffer; hash: string; seq: number; mtime: number }> {
    const response = await this.send({ method: 'GET', path: `/v1/file?path=${encodeURIComponent(path)}` });
    if (response.status === 404) throw new ApiError(`No such file on the server: ${path}`, 404, 'not_found');
    if (response.status !== 200) {
      throw new ApiError(`Could not download ${path} (HTTP ${response.status}).`, response.status);
    }
    return {
      content: response.body,
      hash: response.headers[HEADERS.hash] ?? '',
      seq: Number(response.headers[HEADERS.seq] ?? 0),
      mtime: Number(response.headers[HEADERS.mtime] ?? 0),
    };
  }

  async putFile(path: string, content: ArrayBuffer, baseHash: string, mtime: number): Promise<PutResponse> {
    const response = await this.send({
      method: 'PUT',
      path: `/v1/file?path=${encodeURIComponent(path)}`,
      headers: {
        'content-type': 'application/octet-stream',
        [HEADERS.baseHash]: baseHash,
        [HEADERS.mtime]: String(mtime),
        [HEADERS.device]: this.deviceId(),
      },
      body: content,
    });
    if (response.status === 409) throw new ConflictError(decodeJson<{ server: FileMeta }>(response).server);
    if (response.status === 413) {
      throw new ApiError(`${path} is larger than the server accepts.`, 413, 'too_large');
    }
    if (response.status !== 200) {
      throw new ApiError(`Could not upload ${path} (HTTP ${response.status}).`, response.status);
    }
    return decodeJson<PutResponse>(response);
  }

  async deleteFile(path: string, baseHash: string): Promise<PutResponse> {
    const response = await this.send({
      method: 'DELETE',
      path: `/v1/file?path=${encodeURIComponent(path)}`,
      headers: { [HEADERS.baseHash]: baseHash, [HEADERS.device]: this.deviceId() },
    });
    if (response.status === 409) throw new ConflictError(decodeJson<{ server: FileMeta }>(response).server);
    if (response.status !== 200) {
      throw new ApiError(`Could not delete ${path} (HTTP ${response.status}).`, response.status);
    }
    return decodeJson<PutResponse>(response);
  }

  async move(from: string, to: string, baseHash: string, mtime: number): Promise<void> {
    const response = await this.send({
      method: 'POST',
      path: '/v1/move',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from, to, baseHash, mtime }),
    });
    if (response.status === 409) throw new ConflictError(decodeJson<{ server: FileMeta }>(response).server);
    if (response.status !== 200) {
      throw new ApiError(`Could not rename ${from} (HTTP ${response.status}).`, response.status);
    }
  }
}
