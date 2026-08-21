# Installing Vault Relay

You need the [server running](self-hosting.md) and a token for each device
before the plugin can do anything.

## Community plugins

Once the plugin is in the community list, this is all it takes on every
platform including iOS and Android:

**Settings → Community plugins → Browse → "Vault Relay" → Install → Enable.**

Review by the Obsidian team takes a few weeks, so until it lands, use one of
the methods below.

## Before then: BRAT

[BRAT](https://github.com/TfTHacker/obsidian42-brat) installs plugins straight
from GitHub and keeps them updated. It works on mobile, which manual
installation does not, comfortably.

1. Install **Obsidian42 - BRAT** from Community plugins and enable it.
2. **Settings → BRAT → Add beta plugin**.
3. Enter `roylet/obsidiansync`.
4. Enable **Vault Relay** under Community plugins.

## Manual installation (desktop)

1. Download `main.js`, `manifest.json` and `styles.css` from the
   [latest release](https://github.com/roylet/obsidiansync/releases/latest).
2. Put all three in `<your vault>/.obsidian/plugins/vault-relay/`.
3. Restart Obsidian, then enable **Vault Relay** under Community plugins.

On iOS and Android, getting files into the vault's `.obsidian` folder by hand
is awkward — but if the folder syncs from a desktop that already has the plugin,
it will appear there too.

## Setting it up on each device

Open **Settings → Vault Relay**:

| Field | What to enter |
| --- | --- |
| **Server URL** | Your tunnel hostname, e.g. `https://vault.example.com` |
| **Access token** | The token minted for *this* device |
| **Device name** | How this device should be labelled in conflict copies |

Press **Test connection**. On success the first sync starts immediately.

> Give the first device you connect the vault you want to keep. Everything it
> has is uploaded, and every device connected afterwards receives it. When a
> later device already has notes of its own, the two sets are merged — files
> that exist on both with different contents become conflict copies, so nothing
> is lost either way.

### Options

- **Sync on startup** — compare with the server as soon as the vault opens.
- **Check for changes every** — how often to poll for other devices' edits
  while Obsidian is open. Your own edits upload immediately regardless.
- **Sync app settings** — also sync the Obsidian config folder: appearance,
  hotkeys, snippets and other plugins. Off by default. Window layouts stay
  per-device.
- **Ignore patterns** — one glob per line, e.g. `private/` or `**/*.tmp`.

## Using it

The status bar shows what sync is doing. There is a ribbon icon to sync now,
and three commands in the palette:

- **Sync now**
- **Compare everything with the server** — a full comparison rather than a
  quick catch-up
- **Show recent conflicts**

### If something looks wrong

**Settings → Vault Relay → Compare everything again** forgets what this device
believes it has synced and re-compares the whole vault. Nothing is deleted:
where the two sides differ, you get conflict copies.

Deleted and overwritten files are kept on the server under `data/trash/` for 30
days, so a mistaken delete is recoverable there too.

### Known limits

- Syncing runs while Obsidian is open. Mobile operating systems suspend
  background apps, so a phone catches up when you next open it rather than
  continuously.
- Files larger than the server's limit (100 MB by default, matching
  Cloudflare's free-plan cap) are reported and skipped.
- Filenames that cannot exist on Windows — containing `< > : " | ? *`, or
  ending in a dot or space — are skipped and reported, because they could not
  be created on every device.
