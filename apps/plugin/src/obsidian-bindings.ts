import { requestUrl, type DataAdapter, type RequestUrlParam } from 'obsidian';
import type { FileStat, HttpFn, HttpRequest, HttpResponse, VaultFs } from './ports.js';

/**
 * Adapts Obsidian's `DataAdapter` to the engine's filesystem port.
 *
 * The adapter is used rather than the higher-level `Vault` API because only it
 * can see dotfiles and the config directory, and because it works uniformly on
 * desktop and mobile.
 */
export class ObsidianVaultFs implements VaultFs {
  constructor(private readonly adapter: DataAdapter) {}

  async list(dir: string): Promise<{ files: string[]; folders: string[] }> {
    const listing = await this.adapter.list(dir);
    return { files: listing.files, folders: listing.folders };
  }

  readBinary(path: string): Promise<ArrayBuffer> {
    return this.adapter.readBinary(path);
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    await this.adapter.writeBinary(path, data);
  }

  exists(path: string): Promise<boolean> {
    return this.adapter.exists(path);
  }

  async stat(path: string): Promise<FileStat | null> {
    const stat = await this.adapter.stat(path);
    if (!stat || stat.type !== 'file') return null;
    return { mtime: stat.mtime, size: stat.size };
  }

  async mkdir(path: string): Promise<void> {
    await this.adapter.mkdir(path);
  }

  async trash(path: string): Promise<void> {
    // Prefer the vault's own `.trash` folder: it is the one place the user can
    // recover from on every platform, including mobile where there is no
    // system trash.
    const trashed = await this.adapter.trashLocal(path).then(
      () => true,
      () => false,
    );
    if (!trashed) await this.adapter.remove(path);
  }

  async remove(path: string): Promise<void> {
    await this.adapter.remove(path);
  }
}

/**
 * HTTP through Obsidian's `requestUrl`.
 *
 * This is the single most important compatibility decision in the plugin.
 * `fetch` from the webview would be subject to CORS and, on iOS and Android,
 * to the app's origin restrictions; `requestUrl` performs the request
 * natively, so the same code works on all four platforms and the server needs
 * no CORS configuration at all.
 */
export function createHttp(serverUrl: () => string): HttpFn {
  return async (request: HttpRequest): Promise<HttpResponse> => {
    const base = serverUrl().trim().replace(/\/+$/, '');
    const params: RequestUrlParam = {
      url: `${base}${request.path}`,
      method: request.method,
      headers: request.headers,
      // Report non-2xx as a normal response: 409 and 410 are part of the
      // protocol, not failures to be caught.
      throw: false,
    };
    if (request.body !== undefined) params.body = request.body;

    const response = await requestUrl(params);

    // Header casing varies by platform; the engine looks them up in lowercase.
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(response.headers ?? {})) {
      headers[key.toLowerCase()] = String(value);
    }

    return { status: response.status, headers, body: response.arrayBuffer };
  };
}
