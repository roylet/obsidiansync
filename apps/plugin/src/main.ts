import {
  App,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  normalizePath,
} from 'obsidian';
import { SyncApi } from './api.js';
import { SyncEngine, type SyncOutcome } from './engine.js';
import { createHttp, ObsidianVaultFs } from './obsidian-bindings.js';
import type { SyncReporter } from './ports.js';
import {
  DEFAULT_SETTINGS,
  PLUGIN_ID,
  ignoreOptionsFrom,
  suggestDeviceName,
  validateSettings,
  type VaultRelaySettings,
} from './settings.js';
import { SyncState } from './state.js';

export default class VaultRelayPlugin extends Plugin {
  override settings: VaultRelaySettings = { ...DEFAULT_SETTINGS };
  private state = new SyncState();
  private engine: SyncEngine | null = null;
  private statusBar: HTMLElement | null = null;
  private debounceTimer: number | null = null;
  private recentConflicts: string[] = [];
  private lastError: string | null = null;

  override async onload(): Promise<void> {
    await this.loadSettings();
    await this.loadState();

    this.statusBar = this.addStatusBarItem();
    this.setStatus('idle');

    this.addSettingTab(new VaultRelaySettingTab(this.app, this));

    this.addRibbonIcon('refresh-cw', 'Sync vault now', () => void this.syncNow());

    this.addCommand({
      id: 'sync-now',
      name: 'Sync now',
      callback: () => void this.syncNow(),
    });
    this.addCommand({
      id: 'full-rescan',
      name: 'Compare everything with the server',
      callback: () => void this.syncNow(true),
    });
    this.addCommand({
      id: 'show-conflicts',
      name: 'Show recent conflicts',
      callback: () => this.showConflicts(),
    });

    this.registerVaultEvents();

    // Poll for other devices' changes, and re-scan periodically because the
    // config directory raises no vault events.
    this.registerInterval(
      window.setInterval(() => void this.syncNow(false, true), this.settings.pollSeconds * 1000),
    );
    this.registerInterval(
      window.setInterval(
        () => void this.syncNow(true, true),
        Math.max(1, this.settings.fullScanMinutes) * 60_000,
      ),
    );

    // Coming back to the app is the moment a phone is most likely to be stale.
    this.registerDomEvent(document, 'visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.syncNow(false, true);
    });

    if (this.settings.syncOnStart) {
      // Wait for the workspace so a first-run scan does not compete with
      // Obsidian's own startup work.
      this.app.workspace.onLayoutReady(() => void this.syncNow(false, true));
    }
  }

  override async onunload(): Promise<void> {
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    await this.saveState();
  }

  // --- wiring ---------------------------------------------------------------

  private get reporter(): SyncReporter {
    return {
      status: (message) => this.setStatus(message),
      conflict: (path, copyPath) => {
        this.recentConflicts.unshift(`${path} → ${copyPath}`);
        this.recentConflicts = this.recentConflicts.slice(0, 20);
        new Notice(`Vault Relay: both versions of "${path}" were kept.\nSee ${copyPath}`, 10_000);
      },
      error: (message) => {
        this.lastError = message;
        new Notice(`Vault Relay: ${message}`, 10_000);
      },
      debug: (message, detail) => console.debug('[vault-relay]', message, detail ?? ''),
    };
  }

  private buildEngine(): SyncEngine | null {
    const problem = validateSettings(this.settings);
    if (problem) {
      this.setStatus('not configured');
      return null;
    }

    const fs = new ObsidianVaultFs(this.app.vault.adapter);
    const api = new SyncApi(
      createHttp(() => this.settings.serverUrl),
      this.settings.token.trim(),
      () => this.state.deviceId,
    );
    return new SyncEngine({
      fs,
      api,
      state: this.state,
      ignore: ignoreOptionsFrom(this.settings, this.app.vault.configDir),
      reporter: this.reporter,
      deviceName: this.settings.deviceName || suggestDeviceName(Platform),
    });
  }

  /** Rebuilt on settings change so a new URL or token takes effect at once. */
  private engineOrBuild(): SyncEngine | null {
    if (!this.engine) this.engine = this.buildEngine();
    return this.engine;
  }

  resetEngine(): void {
    this.engine = null;
  }

  private registerVaultEvents(): void {
    const touch = (file: TAbstractFile): void => {
      this.engineOrBuild()?.markDirty(file.path);
      this.scheduleSync();
    };

    this.registerEvent(this.app.vault.on('create', touch));
    this.registerEvent(this.app.vault.on('modify', touch));
    this.registerEvent(this.app.vault.on('delete', touch));
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        // Obsidian tells us the old path directly, so a rename can be sent as
        // a move rather than a delete plus a full re-upload.
        void this.runRename(oldPath, file.path);
      }),
    );
  }

  /** Collapse a burst of keystrokes into one upload. */
  private scheduleSync(): void {
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(
      () => {
        this.debounceTimer = null;
        void this.syncNow(false, true);
      },
      Math.max(0, this.settings.debounceSeconds) * 1000,
    );
  }

  private async runRename(from: string, to: string): Promise<void> {
    const engine = this.engineOrBuild();
    if (!engine) return;
    try {
      await engine.handleRename(normalizePath(from), normalizePath(to));
      await this.saveState();
    } catch (error) {
      this.reportFailure(error, true);
    }
  }

  // --- running a sync -------------------------------------------------------

  async syncNow(fullScan = false, quiet = false): Promise<void> {
    const engine = this.engineOrBuild();
    if (!engine) {
      if (!quiet) new Notice(validateSettings(this.settings) ?? 'Vault Relay is not configured.');
      return;
    }

    this.setStatus('syncing…');
    try {
      const outcome = await engine.sync(fullScan);
      this.lastError = null;
      this.reportOutcome(outcome, quiet);
    } catch (error) {
      this.reportFailure(error, quiet);
    } finally {
      await this.saveState();
    }
  }

  private reportOutcome(outcome: SyncOutcome, quiet: boolean): void {
    const changed =
      outcome.pulled + outcome.pushed + outcome.deletedLocal + outcome.deletedRemote + outcome.conflicts;
    this.setStatus(changed === 0 ? 'up to date' : `synced ${changed}`);

    if (outcome.skipped.length > 0) {
      new Notice(
        `Vault Relay skipped ${outcome.skipped.length} file(s) that cannot sync across platforms:\n` +
          outcome.skipped.slice(0, 5).join('\n'),
        10_000,
      );
    }
    if (!quiet && changed === 0) new Notice('Vault Relay: already up to date.');
  }

  private reportFailure(error: unknown, quiet: boolean): void {
    const message = error instanceof Error ? error.message : String(error);
    this.lastError = message;
    this.setStatus('sync failed');
    console.error('[vault-relay] sync failed', error);
    if (!quiet) new Notice(`Vault Relay: ${message}`, 10_000);
  }

  private setStatus(text: string): void {
    this.statusBar?.setText(`⟳ ${text}`);
  }

  private showConflicts(): void {
    if (this.recentConflicts.length === 0) {
      new Notice('Vault Relay: no conflicts this session.');
      return;
    }
    new Notice(`Recent conflicts:\n${this.recentConflicts.join('\n')}`, 15_000);
  }

  // --- persistence ----------------------------------------------------------

  private get statePath(): string {
    return normalizePath(`${this.app.vault.configDir}/plugins/${PLUGIN_ID}/state.json`);
  }

  async loadSettings(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<VaultRelaySettings>) };
    if (!this.settings.deviceName) {
      this.settings.deviceName = suggestDeviceName(Platform);
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.resetEngine();
  }

  private async loadState(): Promise<void> {
    try {
      const raw = (await this.app.vault.adapter.exists(this.statePath))
        ? await this.app.vault.adapter.read(this.statePath)
        : null;
      this.state = SyncState.fromJson(raw);
    } catch {
      // Losing this file costs one full comparison, not data.
      this.state = new SyncState();
    }
  }

  async saveState(): Promise<void> {
    if (!this.state.isDirty) return;
    try {
      await this.app.vault.adapter.write(this.statePath, this.state.toJson());
      this.state.markClean();
    } catch (error) {
      console.error('[vault-relay] could not save sync state', error);
    }
  }

  /** Forget everything and compare from scratch; used by the settings tab. */
  async resetSyncState(): Promise<void> {
    this.state = new SyncState();
    await this.app.vault.adapter.write(this.statePath, this.state.toJson());
    this.resetEngine();
  }

  get lastErrorMessage(): string | null {
    return this.lastError;
  }

  get syncState(): SyncState {
    return this.state;
  }
}

class VaultRelaySettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: VaultRelayPlugin,
  ) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Server URL')
      .setDesc('The address of your sync server, for example https://vault.example.com')
      .addText((text) =>
        text
          .setPlaceholder('https://vault.example.com')
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Access token')
      .setDesc('Created on the server with: node dist/cli.js token add "<device>"')
      .addText((text) => {
        text.inputEl.type = 'password';
        text
          .setPlaceholder('paste the token')
          .setValue(this.plugin.settings.token)
          .onChange(async (value) => {
            this.plugin.settings.token = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Device name')
      .setDesc('Used to label conflict copies, so you can tell which device made them.')
      .addText((text) =>
        text.setValue(this.plugin.settings.deviceName).onChange(async (value) => {
          this.plugin.settings.deviceName = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName('Connection').addButton((button) =>
      button
        .setButtonText('Test connection')
        .setCta()
        .onClick(async () => {
          const problem = validateSettings(this.plugin.settings);
          if (problem) {
            new Notice(problem);
            return;
          }
          button.setDisabled(true);
          try {
            await this.plugin.syncNow(false, false);
            new Notice('Vault Relay: connection works.');
          } catch (error) {
            new Notice(`Vault Relay: ${error instanceof Error ? error.message : String(error)}`);
          } finally {
            button.setDisabled(false);
          }
        }),
    );

    new Setting(containerEl).setName('Syncing').setHeading();

    new Setting(containerEl)
      .setName('Sync on startup')
      .setDesc('Compare with the server as soon as the vault opens.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncOnStart).onChange(async (value) => {
          this.plugin.settings.syncOnStart = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Check for changes every')
      .setDesc('Seconds between checks for changes made on your other devices.')
      .addSlider((slider) =>
        slider
          .setLimits(5, 120, 5)
          .setValue(this.plugin.settings.pollSeconds)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.pollSeconds = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Sync app settings')
      .setDesc(
        'Also sync the Obsidian config folder: appearance, hotkeys, snippets and other plugins. ' +
          'Window layouts stay per-device and are never synced.',
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncConfig).onChange(async (value) => {
          this.plugin.settings.syncConfig = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Ignore patterns')
      .setDesc('One pattern per line, for example private/ or **/*.tmp')
      .addTextArea((area) => {
        area.inputEl.rows = 5;
        area.setValue(this.plugin.settings.ignorePatterns).onChange(async (value) => {
          this.plugin.settings.ignorePatterns = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl).setName('Troubleshooting').setHeading();

    const status = this.plugin.lastErrorMessage
      ? `Last error: ${this.plugin.lastErrorMessage}`
      : 'No errors reported.';
    new Setting(containerEl).setName('Status').setDesc(status);

    new Setting(containerEl)
      .setName('Compare everything again')
      .setDesc(
        'Forget what this device thinks it has synced and compare the whole vault with the server. ' +
          'Nothing is deleted; differences become conflict copies.',
      )
      .addButton((button) =>
        button.setButtonText('Reset and compare').onClick(async () => {
          await this.plugin.resetSyncState();
          await this.plugin.syncNow(true, false);
          this.display();
        }),
      );
  }
}
