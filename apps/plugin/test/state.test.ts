import { describe, expect, it } from 'vitest';
import { SyncState } from '../src/state.js';
import { DEFAULT_SETTINGS, ignoreOptionsFrom, suggestDeviceName, validateSettings } from '../src/settings.js';

describe('SyncState', () => {
  it('starts empty', () => {
    const state = new SyncState();
    expect(state.isEmpty).toBe(true);
    expect(state.lastSeq).toBe(0);
    expect(state.deviceId).toBe('');
  });

  it('round-trips through JSON', () => {
    const state = new SyncState();
    state.setIdentity('device-1', 'vault-1');
    state.setCursor(42);
    state.record('a.md', { hash: 'abc', size: 3, mtime: 100, seq: 7 });

    const restored = SyncState.fromJson(state.toJson());
    expect(restored.deviceId).toBe('device-1');
    expect(restored.vaultId).toBe('vault-1');
    expect(restored.lastSeq).toBe(42);
    expect(restored.get('a.md')).toEqual({ hash: 'abc', size: 3, mtime: 100, seq: 7 });
  });

  it('never moves the cursor backwards', () => {
    // An out-of-order or retried response would otherwise replay changes that
    // have already been applied.
    const state = new SyncState();
    state.setCursor(10);
    state.setCursor(5);
    expect(state.lastSeq).toBe(10);
  });

  it('falls back to a clean state for corrupt or missing data', () => {
    // Costs one full comparison; refusing to start would cost the user their sync.
    expect(SyncState.fromJson(null).isEmpty).toBe(true);
    expect(SyncState.fromJson('not json at all').isEmpty).toBe(true);
    expect(SyncState.fromJson('{"version":99}').isEmpty).toBe(true);
    expect(SyncState.fromJson('{"version":1,"records":null}').isEmpty).toBe(true);
  });

  it('tracks whether it needs saving', () => {
    const state = new SyncState();
    expect(state.isDirty).toBe(false);
    state.record('a.md', { hash: 'x', size: 1, mtime: 1, seq: 1 });
    expect(state.isDirty).toBe(true);
    state.markClean();
    expect(state.isDirty).toBe(false);
    state.forget('missing.md');
    expect(state.isDirty).toBe(false); // forgetting nothing changes nothing
    state.forget('a.md');
    expect(state.isDirty).toBe(true);
  });
});

describe('settings', () => {
  it('rejects an unconfigured server', () => {
    expect(validateSettings(DEFAULT_SETTINGS)).toMatch(/server URL/i);
  });

  it('requires an absolute http(s) URL', () => {
    const settings = { ...DEFAULT_SETTINGS, serverUrl: 'vault.example.com', token: 't' };
    expect(validateSettings(settings)).toMatch(/https:\/\//);
  });

  it('requires a token', () => {
    const settings = { ...DEFAULT_SETTINGS, serverUrl: 'https://vault.example.com', token: '  ' };
    expect(validateSettings(settings)).toMatch(/token/i);
  });

  it('accepts a complete configuration', () => {
    const settings = { ...DEFAULT_SETTINGS, serverUrl: 'https://vault.example.com', token: 'abc' };
    expect(validateSettings(settings)).toBeUndefined();
  });

  it('names devices from the Obsidian platform flags, not process.platform', () => {
    const base = { isIosApp: false, isAndroidApp: false, isMacOS: false, isWin: false };
    expect(suggestDeviceName({ ...base, isIosApp: true })).toBe('iPhone');
    expect(suggestDeviceName({ ...base, isAndroidApp: true })).toBe('Android');
    expect(suggestDeviceName({ ...base, isMacOS: true })).toBe('Mac');
    expect(suggestDeviceName({ ...base, isWin: true })).toBe('Windows');
    expect(suggestDeviceName(base)).toBe('Desktop');
  });

  it('builds ignore options that always exclude its own plugin folder', () => {
    const options = ignoreOptionsFrom(
      { ...DEFAULT_SETTINGS, syncConfig: true, ignorePatterns: 'private/\n\n# comment' },
      '.obsidian',
    );
    expect(options.configDir).toBe('.obsidian');
    expect(options.pluginId).toBe('vault-relay');
    expect(options.patterns).toContain('private/');
  });
});
