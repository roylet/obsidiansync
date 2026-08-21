import { describe, expect, it } from 'vitest';
import { conflictPath, isConflictPath, sanitizeDeviceName } from '../src/conflict.js';
import { MAX_PATH_LENGTH, normalizeVaultPath } from '../src/paths.js';

// Local time, so the expected strings below are computed the same way.
const when = new Date(2026, 7, 21, 14, 20);

describe('conflictPath', () => {
  it('inserts the marker before the extension', () => {
    expect(conflictPath('notes/Meeting.md', 'iPhone', when)).toBe(
      'notes/Meeting (conflict 2026-08-21 1420 iPhone).md',
    );
  });

  it('handles a file at the vault root', () => {
    expect(conflictPath('Inbox.md', 'Desktop', when)).toBe(
      'Inbox (conflict 2026-08-21 1420 Desktop).md',
    );
  });

  it('handles a file with no extension', () => {
    expect(conflictPath('notes/README', 'Pixel', when)).toBe(
      'notes/README (conflict 2026-08-21 1420 Pixel)',
    );
  });

  it('keeps only the final extension of a multi-part name', () => {
    expect(conflictPath('a/archive.tar.gz', 'NAS', when)).toBe(
      'a/archive.tar (conflict 2026-08-21 1420 NAS).gz',
    );
  });

  it('produces a path that is itself valid', () => {
    const result = conflictPath('notes/Meeting.md', 'iPhone', when);
    expect(() => normalizeVaultPath(result)).not.toThrow();
  });

  it('truncates a long name so the result still fits', () => {
    // A path already at the limit: adding the conflict suffix must not push
    // the result past it. (Longer inputs cannot occur; the server rejects
    // them on write.)
    const long = `notes/${'x'.repeat(MAX_PATH_LENGTH - 'notes/'.length - '.md'.length)}.md`;
    expect(long).toHaveLength(MAX_PATH_LENGTH);
    const result = conflictPath(long, 'iPhone', when);
    expect(result.length).toBeLessThanOrEqual(MAX_PATH_LENGTH);
    expect(result.startsWith('notes/xxx')).toBe(true);
    expect(result.endsWith(' iPhone).md')).toBe(true);
  });

  it('does not leave a trailing dot or space after truncation', () => {
    const name = `${'x'.repeat(MAX_PATH_LENGTH - 60)}. .md`;
    expect(() => conflictPath(`notes/${name}`, 'iPhone', when)).not.toThrow();
  });

  it('conflicting twice on the same file yields distinct paths at different minutes', () => {
    const later = new Date(2026, 7, 21, 14, 21);
    expect(conflictPath('a.md', 'iPhone', when)).not.toBe(conflictPath('a.md', 'iPhone', later));
  });
});

describe('sanitizeDeviceName', () => {
  it('strips characters that are illegal in a filename', () => {
    expect(sanitizeDeviceName('Tom\'s iPhone: 15/Pro')).toBe("Tom's iPhone 15 Pro");
  });

  it('removes parentheses so the marker cannot be spoofed', () => {
    expect(sanitizeDeviceName('Mac (work)')).toBe('Mac work');
  });

  it('falls back when nothing usable is left', () => {
    expect(sanitizeDeviceName('')).toBe('device');
    expect(sanitizeDeviceName('///')).toBe('device');
  });

  it('caps the length', () => {
    expect(sanitizeDeviceName('n'.repeat(100))).toHaveLength(32);
  });
});

describe('isConflictPath', () => {
  it('recognises its own output', () => {
    expect(isConflictPath(conflictPath('notes/Meeting.md', 'iPhone', when))).toBe(true);
    expect(isConflictPath(conflictPath('notes/README', 'Pixel', when))).toBe(true);
  });

  it('does not flag ordinary notes', () => {
    expect(isConflictPath('notes/Meeting.md')).toBe(false);
    expect(isConflictPath('notes/Conflict resolution.md')).toBe(false);
    expect(isConflictPath('notes/Meeting (draft).md')).toBe(false);
  });
});
