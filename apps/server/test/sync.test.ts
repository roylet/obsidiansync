import { describe, expect, it } from 'vitest';
import type { FileMeta, ManifestEntry, SyncAction } from '@obsidiansync/protocol';
import { buildNegotiationPlan } from '../src/sync.js';

function serverFile(path: string, hash: string, extra: Partial<FileMeta> = {}): FileMeta {
  return { path, hash, size: hash.length, mtime: 1000, deleted: false, seq: 1, device: 'srv', ...extra };
}

function tombstone(path: string, mtime = 1000): FileMeta {
  return { path, hash: '', size: 0, mtime, deleted: true, seq: 2, device: 'srv' };
}

function clientFile(path: string, hash: string, extra: Partial<ManifestEntry> = {}): ManifestEntry {
  return { path, hash, size: hash.length, mtime: 1000, ...extra };
}

/** The op chosen for `path`, for terse assertions. */
function opFor(actions: SyncAction[], path: string): string | undefined {
  const action = actions.find((a) => ('meta' in a ? a.meta.path : a.path) === path);
  return action?.op;
}

describe('buildNegotiationPlan', () => {
  it('pulls a file the client has never seen', () => {
    const plan = buildNegotiationPlan([serverFile('a.md', 'aaa')], []);
    expect(opFor(plan, 'a.md')).toBe('pull');
  });

  it('pushes a file the server has never seen', () => {
    const plan = buildNegotiationPlan([], [clientFile('a.md', 'aaa')]);
    expect(opFor(plan, 'a.md')).toBe('push');
  });

  it('reports matching hashes as in-sync', () => {
    const plan = buildNegotiationPlan([serverFile('a.md', 'aaa')], [clientFile('a.md', 'aaa')]);
    expect(opFor(plan, 'a.md')).toBe('in-sync');
  });

  it('does nothing when both sides agree a file is gone', () => {
    const plan = buildNegotiationPlan([tombstone('a.md')], []);
    expect(plan).toHaveLength(0);
  });

  describe('with a known base hash, it can tell which side moved', () => {
    it('pushes when only the client changed', () => {
      const plan = buildNegotiationPlan(
        [serverFile('a.md', 'base')],
        [clientFile('a.md', 'mine', { baseHash: 'base' })],
      );
      expect(opFor(plan, 'a.md')).toBe('push');
    });

    it('pulls when only the server changed', () => {
      const plan = buildNegotiationPlan(
        [serverFile('a.md', 'theirs')],
        [clientFile('a.md', 'base', { baseHash: 'base' })],
      );
      expect(opFor(plan, 'a.md')).toBe('pull');
    });

    it('conflicts when both changed', () => {
      const plan = buildNegotiationPlan(
        [serverFile('a.md', 'theirs')],
        [clientFile('a.md', 'mine', { baseHash: 'base' })],
      );
      expect(opFor(plan, 'a.md')).toBe('conflict');
    });
  });

  it('conflicts on differing hashes when the client has no base, which is all it can know', () => {
    const plan = buildNegotiationPlan([serverFile('a.md', 'theirs')], [clientFile('a.md', 'mine')]);
    expect(opFor(plan, 'a.md')).toBe('conflict');
  });

  describe('tombstones', () => {
    it('applies a delete the client has not seen yet', () => {
      const plan = buildNegotiationPlan(
        [tombstone('a.md')],
        [clientFile('a.md', 'base', { baseHash: 'base' })],
      );
      expect(opFor(plan, 'a.md')).toBe('delete-local');
    });

    it('resurrects a file the client edited after it last synced', () => {
      const plan = buildNegotiationPlan(
        [tombstone('a.md')],
        [clientFile('a.md', 'edited', { baseHash: 'base' })],
      );
      expect(opFor(plan, 'a.md')).toBe('push');
    });

    it('ignores clock skew when the base hash already answers the question', () => {
      // The client's file looks newer than the delete, but its content is
      // provably unchanged, so the delete must still win.
      const plan = buildNegotiationPlan(
        [tombstone('a.md', 1000)],
        [clientFile('a.md', 'base', { baseHash: 'base', mtime: 9999 })],
      );
      expect(opFor(plan, 'a.md')).toBe('delete-local');
    });

    it('falls back to timestamps only when the client has no base', () => {
      const newer = buildNegotiationPlan([tombstone('a.md', 1000)], [clientFile('a.md', 'x', { mtime: 2000 })]);
      expect(opFor(newer, 'a.md')).toBe('push');

      const older = buildNegotiationPlan([tombstone('a.md', 2000)], [clientFile('a.md', 'x', { mtime: 1000 })]);
      expect(opFor(older, 'a.md')).toBe('delete-local');
    });
  });

  it('plans a whole first-time sync of a populated vault against an empty device', () => {
    const plan = buildNegotiationPlan(
      [serverFile('a.md', 'a'), serverFile('b/c.md', 'c'), tombstone('gone.md')],
      [],
    );
    expect(plan.filter((a) => a.op === 'pull')).toHaveLength(2);
    expect(plan.filter((a) => a.op === 'delete-local')).toHaveLength(0);
  });

  it('plans a whole first-time sync of a populated device against an empty server', () => {
    const plan = buildNegotiationPlan([], [clientFile('a.md', 'a'), clientFile('b/c.md', 'c')]);
    expect(plan.every((a) => a.op === 'push')).toBe(true);
    expect(plan).toHaveLength(2);
  });

  it('covers every path exactly once across a mixed vault', () => {
    const plan = buildNegotiationPlan(
      [serverFile('same.md', 'x'), serverFile('theirs.md', 'new'), tombstone('deleted.md')],
      [
        clientFile('same.md', 'x', { baseHash: 'x' }),
        clientFile('theirs.md', 'old', { baseHash: 'old' }),
        clientFile('deleted.md', 'old', { baseHash: 'old' }),
        clientFile('mine.md', 'fresh'),
      ],
    );
    const paths = plan.map((a) => ('meta' in a ? a.meta.path : a.path));
    expect(new Set(paths).size).toBe(paths.length);
    expect(opFor(plan, 'same.md')).toBe('in-sync');
    expect(opFor(plan, 'theirs.md')).toBe('pull');
    expect(opFor(plan, 'deleted.md')).toBe('delete-local');
    expect(opFor(plan, 'mine.md')).toBe('push');
  });
});
