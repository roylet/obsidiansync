import type { FileMeta, ManifestEntry, SyncAction } from '@obsidiansync/protocol';

/**
 * Negotiation: given everything the server holds and a client's full manifest,
 * work out what that client must do to converge.
 *
 * This runs when a device connects for the first time, and whenever a device
 * has been offline long enough that its cursor is no longer usable. All the
 * divergence reasoning lives here rather than in the plugin so that every
 * platform behaves identically and the logic is testable without a phone.
 *
 * Each decision is a three-way comparison between the server's hash, the
 * client's current hash, and the server hash the client last recorded
 * (`baseHash`). The base is what distinguishes "the other side changed" from
 * "we both changed"; without it the only safe answer to differing hashes is a
 * conflict, which is what a brand-new device correctly gets.
 */
export function buildNegotiationPlan(
  serverFiles: FileMeta[],
  clientFiles: ManifestEntry[],
): SyncAction[] {
  const server = new Map(serverFiles.map((f) => [f.path, f]));
  const client = new Map(clientFiles.map((f) => [f.path, f]));
  const actions: SyncAction[] = [];

  for (const [path, remote] of server) {
    const local = client.get(path);

    if (remote.deleted) {
      if (!local) continue; // Both sides agree it is gone.
      // When the client knows what it last synced, that answers the question
      // outright: an unchanged copy means it simply has not applied the delete
      // yet. Only a client with no base has to fall back to timestamps, which
      // are client-reported and so vulnerable to clock skew.
      const resurrect =
        local.baseHash !== undefined ? local.baseHash !== local.hash : local.mtime > remote.mtime;
      actions.push(resurrect ? { op: 'push', path } : { op: 'delete-local', meta: remote });
      continue;
    }

    if (!local) {
      actions.push({ op: 'pull', meta: remote });
    } else if (local.hash === remote.hash) {
      actions.push({ op: 'in-sync', meta: remote });
    } else if (local.baseHash !== undefined && local.baseHash === remote.hash) {
      // Server is unchanged since the client last saw it, so the difference is
      // the client's own edit.
      actions.push({ op: 'push', path });
    } else if (local.baseHash !== undefined && local.baseHash === local.hash) {
      // The client is untouched since it last synced, so the server moved on.
      actions.push({ op: 'pull', meta: remote });
    } else {
      actions.push({ op: 'conflict', meta: remote });
    }
  }

  for (const path of client.keys()) {
    // The server has never heard of this path at all, so there is nothing to
    // conflict with, whatever the client's base says.
    if (!server.has(path)) actions.push({ op: 'push', path });
  }

  return actions;
}
