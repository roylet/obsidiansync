import type { IgnoreOptions } from '@obsidiansync/protocol';

export interface VaultRelaySettings {
  serverUrl: string;
  token: string;
  /** Shown in conflict-copy names, so it should say which device this is. */
  deviceName: string;
  /** Seconds between polls for other devices' changes, while Obsidian is open. */
  pollSeconds: number;
  /** Seconds to wait after an edit before uploading, so typing is not chatty. */
  debounceSeconds: number;
  /**
   * Minutes between full vault re-scans. This is what carries the config
   * directory, which does not raise vault change events.
   */
  fullScanMinutes: number;
  syncOnStart: boolean;
  syncConfig: boolean;
  /** One glob per line. */
  ignorePatterns: string;
}

export const DEFAULT_SETTINGS: VaultRelaySettings = {
  serverUrl: '',
  token: '',
  deviceName: '',
  pollSeconds: 10,
  debounceSeconds: 2,
  fullScanMinutes: 5,
  syncOnStart: true,
  syncConfig: false,
  ignorePatterns: '',
};

export const PLUGIN_ID = 'vault-relay';

export function ignoreOptionsFrom(settings: VaultRelaySettings, configDir: string): IgnoreOptions {
  return {
    syncConfig: settings.syncConfig,
    configDir,
    pluginId: PLUGIN_ID,
    patterns: settings.ignorePatterns.split('\n'),
  };
}

/**
 * Which platform this is, as reported by Obsidian.
 *
 * Taken as a parameter rather than read from `process.platform`, which does
 * not exist on iOS or Android - the two platforms this plugin most needs to
 * work on.
 */
export interface PlatformFlags {
  isIosApp: boolean;
  isAndroidApp: boolean;
  isMacOS: boolean;
  isWin: boolean;
}

/** A reasonable default device name, so conflict copies are identifiable. */
export function suggestDeviceName(platform: PlatformFlags): string {
  if (platform.isIosApp) return 'iPhone';
  if (platform.isAndroidApp) return 'Android';
  if (platform.isMacOS) return 'Mac';
  if (platform.isWin) return 'Windows';
  return 'Desktop';
}

export function validateSettings(settings: VaultRelaySettings): string | undefined {
  const url = settings.serverUrl.trim();
  if (url === '') return 'Set the server URL in the Vault Relay settings.';
  if (!/^https?:\/\//i.test(url)) return 'The server URL must start with https:// or http://.';
  if (settings.token.trim() === '') return 'Set the access token in the Vault Relay settings.';
  return undefined;
}
