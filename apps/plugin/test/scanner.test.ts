import { describe, expect, it } from 'vitest';
import { sha256Hex, type IgnoreOptions } from '@obsidiansync/protocol';
import { hashFile, scanVault } from '../src/scanner.js';
import { FakeVault } from './fake-vault.js';

const ignore: IgnoreOptions = {
  syncConfig: false,
  configDir: '.obsidian',
  pluginId: 'vault-relay',
  patterns: [],
};

describe('scanVault', () => {
  it('walks nested folders and hashes every file in scope', async () => {
    const vault = new FakeVault({
      'a.md': 'one',
      'notes/b.md': 'two',
      'notes/deep/c.md': 'three',
    });
    const result = await scanVault(vault, ignore);

    expect([...result.files.keys()].sort()).toEqual(['a.md', 'notes/b.md', 'notes/deep/c.md']);
    expect(result.files.get('a.md')!.hash).toBe(await sha256Hex(new TextEncoder().encode('one')));
  });

  it('records size and modification time', async () => {
    const vault = new FakeVault();
    vault.writeText('a.md', 'hello', 12345);
    const result = await scanVault(vault, ignore);
    expect(result.files.get('a.md')).toMatchObject({ size: 5, mtime: 12345 });
  });

  it('skips ignored files and never descends into ignored folders', async () => {
    const vault = new FakeVault({
      'keep.md': 'yes',
      '.git/config': 'no',
      '.git/objects/ab/cd': 'no',
      '.obsidian/appearance.json': 'no',
      'notes/.DS_Store': 'no',
    });
    const result = await scanVault(vault, ignore);
    expect([...result.files.keys()]).toEqual(['keep.md']);
  });

  it('includes config files when config sync is enabled', async () => {
    const vault = new FakeVault({
      'keep.md': 'yes',
      '.obsidian/appearance.json': 'theme',
      '.obsidian/workspace.json': 'layout',
    });
    const result = await scanVault(vault, { ...ignore, syncConfig: true });
    expect([...result.files.keys()].sort()).toEqual(['.obsidian/appearance.json', 'keep.md']);
  });

  it('reports files whose names cannot cross platforms instead of dropping them', async () => {
    const vault = new FakeVault({ 'good.md': 'ok' });
    // A name Windows cannot represent; macOS and Linux happily create it.
    vault.writeText('bad:name.md', 'oops');

    const result = await scanVault(vault, ignore);
    expect([...result.files.keys()]).toEqual(['good.md']);
    expect(result.skipped).toEqual(['bad:name.md']);
  });

  it('returns nothing for an empty vault', async () => {
    const result = await scanVault(new FakeVault(), ignore);
    expect(result.files.size).toBe(0);
    expect(result.skipped).toEqual([]);
  });
});

describe('hashFile', () => {
  it('hashes an existing file', async () => {
    const vault = new FakeVault({ 'a.md': 'content' });
    const file = await hashFile(vault, 'a.md');
    expect(file?.hash).toBe(await sha256Hex(new TextEncoder().encode('content')));
  });

  it('returns undefined for a file that is gone, rather than throwing', async () => {
    expect(await hashFile(new FakeVault(), 'missing.md')).toBeUndefined();
  });
});
