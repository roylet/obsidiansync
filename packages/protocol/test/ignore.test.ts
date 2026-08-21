import { describe, expect, it } from 'vitest';
import { effectiveIgnorePatterns, isIgnored, matchesGlob } from '../src/ignore.js';

const base = { configDir: '.obsidian', pluginId: 'vault-relay-sync' };
const notesOnly = { ...base, syncConfig: false };
const withConfig = { ...base, syncConfig: true };

describe('matchesGlob', () => {
  it('matches * within a single segment only', () => {
    expect(matchesGlob('notes/a.md', 'notes/*.md')).toBe(true);
    expect(matchesGlob('notes/deep/a.md', 'notes/*.md')).toBe(false);
  });

  it('matches ** across segments', () => {
    expect(matchesGlob('notes/deep/a.md', 'notes/**')).toBe(true);
    expect(matchesGlob('a/b/c/.DS_Store', '**/.DS_Store')).toBe(true);
  });

  it('lets **/ match zero directories', () => {
    expect(matchesGlob('.DS_Store', '**/.DS_Store')).toBe(true);
  });

  it('matches ? against exactly one non-separator character', () => {
    expect(matchesGlob('a1.md', 'a?.md')).toBe(true);
    expect(matchesGlob('a12.md', 'a?.md')).toBe(false);
    expect(matchesGlob('a/b.md', 'a?b.md')).toBe(false);
  });

  it('treats a trailing slash as a directory prefix', () => {
    expect(matchesGlob('.git', '.git/')).toBe(true);
    expect(matchesGlob('.git/config', '.git/')).toBe(true);
    expect(matchesGlob('.git/objects/ab/cd', '.git/')).toBe(true);
    // Must not match a sibling that merely shares the prefix.
    expect(matchesGlob('.gitignore', '.git/')).toBe(false);
  });

  it('escapes regex metacharacters in literal segments', () => {
    expect(matchesGlob('notes/a+b(1).md', 'notes/a+b(1).md')).toBe(true);
    expect(matchesGlob('notes/axb1x.md', 'notes/a+b(1).md')).toBe(false);
  });

  it('is case-insensitive, since the same vault spans case-sensitive filesystems', () => {
    expect(matchesGlob('a/thumbs.db', '**/Thumbs.db')).toBe(true);
  });
});

describe('isIgnored', () => {
  it('always ignores VCS and OS junk', () => {
    expect(isIgnored('.git/config', notesOnly)).toBe(true);
    expect(isIgnored('.trash/old.md', notesOnly)).toBe(true);
    expect(isIgnored('notes/.DS_Store', notesOnly)).toBe(true);
  });

  it('syncs ordinary notes and attachments', () => {
    expect(isIgnored('notes/daily/2026-08-21.md', notesOnly)).toBe(false);
    expect(isIgnored('attachments/diagram.png', notesOnly)).toBe(false);
    expect(isIgnored('.gitignore', notesOnly)).toBe(false);
  });

  it('ignores the whole config directory when config sync is off', () => {
    expect(isIgnored('.obsidian/appearance.json', notesOnly)).toBe(true);
    expect(isIgnored('.obsidian/plugins/dataview/main.js', notesOnly)).toBe(true);
  });

  it('syncs config files when config sync is on', () => {
    expect(isIgnored('.obsidian/appearance.json', withConfig)).toBe(false);
    expect(isIgnored('.obsidian/snippets/custom.css', withConfig)).toBe(false);
    expect(isIgnored('.obsidian/plugins/dataview/main.js', withConfig)).toBe(false);
  });

  it('never syncs per-device workspace files, even with config sync on', () => {
    expect(isIgnored('.obsidian/workspace.json', withConfig)).toBe(true);
    expect(isIgnored('.obsidian/workspace-mobile.json', withConfig)).toBe(true);
  });

  it('never syncs its own plugin directory, which holds the server token', () => {
    expect(isIgnored('.obsidian/plugins/vault-relay-sync/data.json', withConfig)).toBe(true);
    expect(isIgnored('.obsidian/plugins/vault-relay-sync/state.json', withConfig)).toBe(true);
  });

  it('honours a custom config directory name', () => {
    const custom = { ...withConfig, configDir: '.config-vault' };
    expect(isIgnored('.config-vault/workspace.json', custom)).toBe(true);
    expect(isIgnored('.obsidian/workspace.json', custom)).toBe(false);
  });

  it('applies user patterns', () => {
    const opts = { ...notesOnly, patterns: ['private/', '**/*.tmp'] };
    expect(isIgnored('private/diary.md', opts)).toBe(true);
    expect(isIgnored('notes/scratch.tmp', opts)).toBe(true);
    expect(isIgnored('notes/keep.md', opts)).toBe(false);
  });

  it('skips blank lines and comments in user patterns', () => {
    const patterns = effectiveIgnorePatterns({ ...notesOnly, patterns: ['', '  ', '# a note'] });
    expect(patterns).not.toContain('');
    expect(patterns.some((p) => p.startsWith('#'))).toBe(false);
  });
});
