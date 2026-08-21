import { describe, expect, it } from 'vitest';
import {
  ancestorDirs,
  basename,
  dirname,
  extname,
  InvalidPathError,
  isValidVaultPath,
  MAX_PATH_LENGTH,
  normalizeVaultPath,
} from '../src/paths.js';

describe('normalizeVaultPath', () => {
  it('keeps an ordinary path untouched', () => {
    expect(normalizeVaultPath('notes/daily/2026-08-21.md')).toBe('notes/daily/2026-08-21.md');
  });

  it('strips leading and trailing separators and collapses duplicates', () => {
    expect(normalizeVaultPath('/notes//daily/')).toBe('notes/daily');
  });

  it('allows spaces, hyphens and unicode in names', () => {
    expect(normalizeVaultPath('My Notes/re-read café.md')).toBe('My Notes/re-read café.md');
  });

  it('normalises macOS NFD filenames to NFC so they match Windows and Linux', () => {
    const nfd = 'cafe\u0301.md'; // what macOS reports
    const nfc = 'caf\u00e9.md'; // what Windows and Linux report
    expect(nfd).not.toBe(nfc);
    expect(normalizeVaultPath(nfd)).toBe(nfc);
    expect(normalizeVaultPath(nfd)).toBe(normalizeVaultPath(nfc));
  });

  describe('rejects paths that could escape the vault root', () => {
    const traversals = [
      '../secrets.md',
      'notes/../../etc/passwd',
      'notes/./x.md',
      '..',
      'C:/Windows/system32',
      'notes\\..\\escape.md',
    ];
    for (const bad of traversals) {
      it(JSON.stringify(bad), () => {
        expect(() => normalizeVaultPath(bad)).toThrow(InvalidPathError);
      });
    }
  });

  it('rejects NUL and other control characters', () => {
    expect(() => normalizeVaultPath('notes/evil\u0000.md')).toThrow(InvalidPathError);
    expect(() => normalizeVaultPath('notes/bell\u0007.md')).toThrow(InvalidPathError);
  });

  it('rejects characters that are illegal on Windows', () => {
    for (const bad of ['a<b.md', 'a>b.md', 'a:b.md', 'a"b.md', 'a|b.md', 'a?b.md', 'a*b.md']) {
      expect(() => normalizeVaultPath(bad), bad).toThrow(InvalidPathError);
    }
  });

  it('rejects Windows reserved device names, with or without an extension', () => {
    expect(() => normalizeVaultPath('CON')).toThrow(InvalidPathError);
    expect(() => normalizeVaultPath('notes/nul.md')).toThrow(InvalidPathError);
    expect(() => normalizeVaultPath('notes/COM4.txt')).toThrow(InvalidPathError);
    // Not reserved: only the exact device names are.
    expect(normalizeVaultPath('notes/console.md')).toBe('notes/console.md');
  });

  it('rejects segments ending in a dot or space, which Windows truncates', () => {
    expect(() => normalizeVaultPath('notes/trailing.')).toThrow(InvalidPathError);
    expect(() => normalizeVaultPath('notes/trailing ')).toThrow(InvalidPathError);
    expect(() => normalizeVaultPath('dir /file.md')).toThrow(InvalidPathError);
  });

  it('rejects empty paths', () => {
    expect(() => normalizeVaultPath('')).toThrow(InvalidPathError);
    expect(() => normalizeVaultPath('///')).toThrow(InvalidPathError);
  });

  it('rejects paths longer than the limit', () => {
    expect(() => normalizeVaultPath('a'.repeat(MAX_PATH_LENGTH + 1))).toThrow(InvalidPathError);
    expect(normalizeVaultPath('a'.repeat(MAX_PATH_LENGTH))).toHaveLength(MAX_PATH_LENGTH);
  });

  it('exposes a non-throwing form', () => {
    expect(isValidVaultPath('notes/ok.md')).toBe(true);
    expect(isValidVaultPath('../nope.md')).toBe(false);
  });
});

describe('path helpers', () => {
  it('splits directory and base name', () => {
    expect(dirname('a/b/c.md')).toBe('a/b');
    expect(dirname('c.md')).toBe('');
    expect(basename('a/b/c.md')).toBe('c.md');
    expect(basename('c.md')).toBe('c.md');
  });

  it('treats a leading dot as part of the name, not an extension', () => {
    expect(extname('a/b/c.md')).toBe('.md');
    expect(extname('archive.tar.gz')).toBe('.gz');
    expect(extname('.gitignore')).toBe('');
    expect(extname('README')).toBe('');
  });

  it('lists ancestor directories outermost first', () => {
    expect(ancestorDirs('a/b/c/d.md')).toEqual(['a', 'a/b', 'a/b/c']);
    expect(ancestorDirs('top.md')).toEqual([]);
  });
});
