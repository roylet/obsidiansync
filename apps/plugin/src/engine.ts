import {
  ancestorDirs,
  conflictPath,
  isIgnored,
  isValidVaultPath,
  sha256Hex,
  type FileMeta,
  type IgnoreOptions,
  type ManifestEntry,
  type SyncAction,
} from '@obsidiansync/protocol';
import { ApiError, ConflictError, CursorExpiredError, type SyncApi } from './api.js';
import { hashFile, scanVault } from './scanner.js';
import type { SyncReporter, VaultFs } from './ports.js';
import { SyncState } from './state.js';

export interface EngineOptions {
  fs: VaultFs;
  api: SyncApi;
  state: SyncState;
  ignore: IgnoreOptions;
  reporter: SyncReporter;
  deviceName: string;
  /** Injectable for deterministic conflict-copy names in tests. */
  now?: () => Date;
}

export interface SyncOutcome {
  pulled: number;
  pushed: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: number;
  skipped: string[];
}

function emptyOutcome(): SyncOutcome {
  return { pulled: 0, pushed: 0, deletedLocal: 0, deletedRemote: 0, conflicts: 0, skipped: [] };
}

/**
 * The sync loop.
 *
 * A cycle is: apply everything the server has that we do not, then push
 * everything we have that it does not. Both directions are driven by comparing
 * three values for each path - the server's hash, the file's current hash, and
 * the hash recorded when the two last agreed. The recorded hash is what makes
 * "who changed?" answerable; where it is missing or both sides moved, the
 * result is a conflict, and a conflict never discards anything: the newer edit
 * keeps the path and the older is written beside it.
 *
 * Self-inflicted echo is handled by construction rather than by suppressing
 * events. Writing a pulled file also records its hash, so when the vault's own
 * change event arrives, the file already matches what was recorded and the
 * push step sees nothing to do.
 */
export class SyncEngine {
  private readonly fs: VaultFs;
  private readonly api: SyncApi;
  private readonly state: SyncState;
  private readonly reporter: SyncReporter;
  private readonly deviceName: string;
  private readonly now: () => Date;
  private ignore: IgnoreOptions;

  /** Paths the watcher has flagged since the last cycle. */
  private readonly pending = new Set<string>();
  private running: Promise<SyncOutcome> | null = null;
  /** Set when a cycle is asked to run while one is already in flight. */
  private rerunRequested = false;

  constructor(options: EngineOptions) {
    this.fs = options.fs;
    this.api = options.api;
    this.state = options.state;
    this.ignore = options.ignore;
    this.reporter = options.reporter;
    this.deviceName = options.deviceName;
    this.now = options.now ?? (() => new Date());
  }

  setIgnore(ignore: IgnoreOptions): void {
    this.ignore = ignore;
  }

  /** Flag a path the watcher saw change. Ignored paths are dropped here. */
  markDirty(path: string): void {
    if (isIgnored(path, this.ignore) || !isValidVaultPath(path)) return;
    this.pending.add(path);
  }

  /**
   * Run a cycle, coalescing concurrent callers.
   *
   * The poll timer, the file watcher and the manual command all call this, and
   * two cycles running at once would race each other's uploads. A request that
   * arrives mid-cycle sets a flag so the work is picked up immediately after,
   * rather than being dropped.
   */
  async sync(fullScan = false): Promise<SyncOutcome> {
    if (this.running) {
      this.rerunRequested = true;
      return this.running;
    }
    this.running = this.runCycle(fullScan).finally(() => {
      this.running = null;
    });
    const outcome = await this.running;

    if (this.rerunRequested) {
      this.rerunRequested = false;
      return this.sync(false);
    }
    return outcome;
  }

  /**
   * Handshake, on the first cycle and after a restart.
   *
   * Besides registering the device, this checks the server's vault id against
   * the one recorded here. A device that was pointed at a different server, or
   * a server whose data directory was recreated, would otherwise merge two
   * unrelated vaults into each other.
   */
  private async connect(): Promise<void> {
    const hello = await this.api.hello(this.deviceName, this.state.deviceId || undefined);

    if (this.state.vaultId && this.state.vaultId !== hello.vaultId) {
      throw new Error(
        'This server is hosting a different vault from the one this device last synced with. ' +
          'If that is intentional, use "Compare everything again" in the settings.',
      );
    }
    this.state.setIdentity(hello.deviceId, hello.vaultId);
  }

  private async runCycle(fullScan: boolean): Promise<SyncOutcome> {
    const outcome = emptyOutcome();

    if (!this.state.deviceId || !this.state.vaultId) {
      await this.connect();
    }

    // A device with no recorded state has nothing to reason from, so it has to
    // compare whole manifests rather than trust a cursor.
    if (fullScan || this.state.isEmpty) {
      await this.negotiate(outcome);
    } else {
      try {
        await this.pull(outcome);
      } catch (error) {
        if (error instanceof CursorExpiredError) {
          this.reporter.debug('cursor expired, renegotiating from a full manifest');
          await this.negotiate(outcome);
        } else {
          throw error;
        }
      }
      await this.pushPending(outcome);
    }

    return outcome;
  }

  // --- negotiation ----------------------------------------------------------

  /** Compare full manifests and execute whatever plan the server returns. */
  private async negotiate(outcome: SyncOutcome): Promise<void> {
    this.reporter.status('Comparing with the server…');
    const scan = await scanVault(this.fs, this.ignore);
    outcome.skipped = scan.skipped;

    const manifest: ManifestEntry[] = [];
    for (const file of scan.files.values()) {
      const record = this.state.get(file.path);
      manifest.push({
        path: file.path,
        hash: file.hash,
        size: file.size,
        mtime: file.mtime,
        ...(record ? { baseHash: record.hash } : {}),
      });
    }
    // A path we recorded but no longer hold locally is a local delete the
    // server has not been told about; it has to appear in the manifest for the
    // server to reason about it, marked as absent.
    for (const path of this.state.paths()) {
      if (!scan.files.has(path)) {
        const record = this.state.get(path)!;
        manifest.push({ path, hash: '', size: 0, mtime: record.mtime, baseHash: record.hash });
      }
    }

    const plan = await this.api.negotiate(manifest);
    for (const action of plan.actions) {
      await this.applyAction(action, scan.files, outcome);
    }
    this.state.setCursor(plan.serverSeq);
    this.pending.clear();
  }

  private async applyAction(
    action: SyncAction,
    localFiles: Map<string, { hash: string; mtime: number; size: number }>,
    outcome: SyncOutcome,
  ): Promise<void> {
    switch (action.op) {
      case 'in-sync': {
        const local = localFiles.get(action.meta.path);
        if (local) {
          this.state.record(action.meta.path, {
            hash: local.hash,
            size: local.size,
            mtime: local.mtime,
            seq: action.meta.seq,
          });
        }
        return;
      }
      case 'pull':
        await this.download(action.meta, outcome);
        return;
      case 'push': {
        // The server said push, but a manifest entry with an empty hash means
        // we no longer hold the file: that is a delete to propagate, not an
        // upload.
        if (localFiles.has(action.path)) {
          await this.upload(action.path, outcome);
        } else {
          await this.pushDelete(action.path, outcome);
        }
        return;
      }
      case 'delete-local':
        await this.applyRemoteDelete(action.meta, outcome);
        return;
      case 'conflict':
        await this.resolveConflict(action.meta, outcome);
        return;
    }
  }

  // --- pulling --------------------------------------------------------------

  /** Apply everything the server has recorded since our cursor. */
  private async pull(outcome: SyncOutcome): Promise<void> {
    let guard = 0;
    for (;;) {
      const page = await this.api.changes(this.state.lastSeq);
      for (const meta of page.changes) {
        if (isIgnored(meta.path, this.ignore)) continue;
        if (meta.deleted) {
          await this.applyRemoteDelete(meta, outcome);
        } else {
          await this.reconcileIncoming(meta, outcome);
        }
      }
      this.state.setCursor(page.seq);
      if (!page.more) return;
      // Defensive: a server that always reported `more` would otherwise spin
      // forever on a phone's battery.
      if (++guard > 1000) return;
    }
  }

  /** Decide what an incoming server version means for our copy of the file. */
  private async reconcileIncoming(meta: FileMeta, outcome: SyncOutcome): Promise<void> {
    const record = this.state.get(meta.path);
    const local = await hashFile(this.fs, meta.path);

    if (!local) {
      // We do not have it. If we never did, it is simply new. If we did and
      // deleted it, our delete has not been pushed yet - but the server's copy
      // may itself be that deletion's target, so compare against the record.
      if (record && record.hash === meta.hash) {
        await this.pushDelete(meta.path, outcome);
        return;
      }
      await this.download(meta, outcome);
      return;
    }

    if (local.hash === meta.hash) {
      this.state.record(meta.path, {
        hash: local.hash,
        size: local.size,
        mtime: local.mtime,
        seq: meta.seq,
      });
      return;
    }

    if (record && record.hash === local.hash) {
      // Our copy is untouched since we last agreed, so this is purely an
      // incoming change.
      await this.download(meta, outcome);
      return;
    }

    if (record && record.hash === meta.hash) {
      // The server still holds exactly what we last agreed on, so nothing has
      // arrived - the difference is our own unpushed edit. This is also the
      // case when the feed replays a change we made ourselves: the cursor is
      // only advanced by pulling, so a device always sees its own uploads come
      // back, and must not mistake them for somebody else's work.
      await this.upload(meta.path, outcome);
      return;
    }

    // Both sides moved, or we have no record at all and cannot prove otherwise.
    await this.resolveConflict(meta, outcome, local);
  }

  private async download(meta: FileMeta, outcome: SyncOutcome): Promise<void> {
    const file = await this.api.getFile(meta.path);
    await this.writeFile(meta.path, file.content);
    const stat = await this.fs.stat(meta.path);
    this.state.record(meta.path, {
      hash: file.hash,
      size: file.content.byteLength,
      mtime: stat?.mtime ?? meta.mtime,
      seq: meta.seq,
    });
    outcome.pulled += 1;
  }

  private async applyRemoteDelete(meta: FileMeta, outcome: SyncOutcome): Promise<void> {
    const record = this.state.get(meta.path);
    const local = await hashFile(this.fs, meta.path);

    if (!local) {
      this.state.forget(meta.path);
      this.state.setCursor(meta.seq);
      return;
    }

    if (record && record.hash !== local.hash) {
      // Edited here after the delete happened elsewhere. Keep the work and put
      // the file back rather than honouring the delete.
      this.reporter.debug(`keeping locally edited ${meta.path} over a remote delete`);
      await this.upload(meta.path, outcome);
      return;
    }

    // Trash rather than unlink, so a delete that turns out to be a mistake is
    // recoverable from the vault's own trash.
    await this.fs.trash(meta.path);
    this.state.forget(meta.path);
    outcome.deletedLocal += 1;
  }

  // --- pushing --------------------------------------------------------------

  /** Upload everything the watcher flagged, plus any deletes it implied. */
  private async pushPending(outcome: SyncOutcome): Promise<void> {
    const paths = [...this.pending];
    this.pending.clear();

    for (const path of paths) {
      const local = await hashFile(this.fs, path);
      if (local) {
        const record = this.state.get(path);
        if (record && record.hash === local.hash) continue; // nothing actually changed
        await this.upload(path, outcome);
      } else if (this.state.get(path)) {
        await this.pushDelete(path, outcome);
      }
    }
  }

  private async upload(path: string, outcome: SyncOutcome): Promise<void> {
    const local = await hashFile(this.fs, path);
    if (!local) return;

    const record = this.state.get(path);
    const content = await this.fs.readBinary(path);

    try {
      const result = await this.api.putFile(path, content, record?.hash ?? '', local.mtime);
      this.state.record(path, {
        hash: result.hash,
        size: local.size,
        mtime: local.mtime,
        seq: result.seq,
      });
      outcome.pushed += 1;
    } catch (error) {
      if (error instanceof ConflictError) {
        await this.resolveConflict(error.server, outcome, local);
        return;
      }
      if (error instanceof ApiError && error.code === 'too_large') {
        // Not retryable: report it once and stop trying, rather than failing
        // this path on every cycle forever.
        this.reporter.error(`${path} is too large for the server and was not synced.`);
        outcome.skipped.push(path);
        return;
      }
      throw error;
    }
  }

  private async pushDelete(path: string, outcome: SyncOutcome): Promise<void> {
    const record = this.state.get(path);
    try {
      await this.api.deleteFile(path, record?.hash ?? '');
      this.state.forget(path);
      outcome.deletedRemote += 1;
    } catch (error) {
      if (error instanceof ConflictError) {
        // Somebody changed it after we deleted ours. Their version wins the
        // path; ours is already gone, so just take theirs.
        if (!error.server.deleted) {
          await this.download(error.server, outcome);
        } else {
          this.state.forget(path);
        }
        return;
      }
      throw error;
    }
  }

  // --- conflicts ------------------------------------------------------------

  /**
   * Resolve a divergence without losing either version.
   *
   * The newer edit (by modification time) keeps the real path; the older is
   * written alongside it as a conflict copy and pushed as an ordinary new
   * file, so it reaches every device. Whichever side is chosen, both bodies
   * survive and the user decides what to merge.
   */
  private async resolveConflict(
    server: FileMeta,
    outcome: SyncOutcome,
    localHint?: { hash: string; mtime: number; size: number },
  ): Promise<void> {
    const path = server.path;
    const local = localHint ?? (await hashFile(this.fs, path));

    if (!local) {
      // Nothing local left to preserve.
      await this.download(server, outcome);
      return;
    }
    if (local.hash === server.hash) {
      this.state.record(path, { hash: local.hash, size: local.size, mtime: local.mtime, seq: server.seq });
      return;
    }

    if (server.deleted) {
      // The file was deleted elsewhere while it was edited here. There is no
      // server version to preserve, and the delete has already been judged
      // less important than the edit, so re-create it. The base hash must be
      // empty: as far as the server is concerned this path is now vacant.
      const content = await this.fs.readBinary(path);
      const result = await this.api.putFile(path, content, '', local.mtime);
      this.state.record(path, {
        hash: result.hash,
        size: local.size,
        mtime: local.mtime,
        seq: result.seq,
      });
      outcome.pushed += 1;
      return;
    }

    const localContent = await this.fs.readBinary(path);
    const remote = await this.api.getFile(path);
    const localWins = local.mtime > server.mtime;

    const copyPath = conflictPath(path, this.deviceName, this.now());
    const loserContent = localWins ? remote.content : localContent;

    if (localWins) {
      // Our copy stays where it is; the server's becomes the conflict copy.
      // Base the upload on the server's current hash so it is accepted.
      await this.api.putFile(path, localContent, remote.hash, local.mtime);
      const meta = await hashFile(this.fs, path);
      this.state.record(path, {
        hash: local.hash,
        size: local.size,
        mtime: meta?.mtime ?? local.mtime,
        seq: server.seq,
      });
    } else {
      await this.writeFile(path, remote.content);
      const stat = await this.fs.stat(path);
      this.state.record(path, {
        hash: remote.hash,
        size: remote.content.byteLength,
        mtime: stat?.mtime ?? server.mtime,
        seq: server.seq,
      });
      outcome.pulled += 1;
    }

    // Write the losing version beside the winner and push it, so it is not
    // stranded on this one device.
    await this.writeFile(copyPath, loserContent);
    const copyHash = await sha256Hex(loserContent);
    const copyStat = await this.fs.stat(copyPath);
    try {
      const result = await this.api.putFile(
        copyPath,
        loserContent,
        '',
        copyStat?.mtime ?? Date.now(),
      );
      this.state.record(copyPath, {
        hash: result.hash,
        size: loserContent.byteLength,
        mtime: copyStat?.mtime ?? Date.now(),
        seq: result.seq,
      });
    } catch (error) {
      if (error instanceof ConflictError) {
        // Another device already created the identical conflict copy.
        this.state.record(copyPath, {
          hash: copyHash,
          size: loserContent.byteLength,
          mtime: copyStat?.mtime ?? Date.now(),
          seq: error.server.seq,
        });
      } else {
        throw error;
      }
    }

    outcome.conflicts += 1;
    this.reporter.conflict(path, copyPath);
  }

  // --- helpers --------------------------------------------------------------

  /** Write a file, creating any parent folders the vault does not have yet. */
  private async writeFile(path: string, content: ArrayBuffer): Promise<void> {
    for (const dir of ancestorDirs(path)) {
      if (!(await this.fs.exists(dir))) {
        await this.fs.mkdir(dir);
      }
    }
    await this.fs.writeBinary(path, content);
  }

  /** Rename on the server, falling back to copy-and-delete if it is refused. */
  async handleRename(from: string, to: string, outcome = emptyOutcome()): Promise<SyncOutcome> {
    const record = this.state.get(from);
    const local = await hashFile(this.fs, to);
    if (!local) return outcome;

    if (isIgnored(to, this.ignore)) {
      // Moved out of scope: as far as the server is concerned it was deleted.
      if (record) await this.pushDelete(from, outcome);
      return outcome;
    }
    if (isIgnored(from, this.ignore) || !record) {
      // Moved into scope, or never tracked: a plain upload.
      await this.upload(to, outcome);
      return outcome;
    }

    try {
      await this.api.move(from, to, record.hash, local.mtime);
      this.state.forget(from);
      this.state.record(to, { hash: record.hash, size: local.size, mtime: local.mtime, seq: 0 });
      outcome.pushed += 1;
    } catch (error) {
      if (error instanceof ConflictError || (error instanceof ApiError && error.status === 404)) {
        // The server's view of either end has moved on. Upload the new path
        // and let the old one be reconciled as a delete.
        await this.upload(to, outcome);
        await this.pushDelete(from, outcome);
        return outcome;
      }
      throw error;
    }
    return outcome;
  }
}
