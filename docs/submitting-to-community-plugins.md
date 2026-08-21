# Submitting Vault Relay to the community plugin list

A checklist for getting the plugin listed, so it can be installed from
**Community plugins → Browse** on every platform.

## Before submitting

The repository already satisfies most of the requirements:

- [x] Public repo with `README.md` and `LICENSE` at the root
- [x] `manifest.json` with `id`, `name`, `version`, `minAppVersion`,
      `description`, `author`
- [x] `isDesktopOnly: false` — the plugin works on iOS and Android
- [x] Neither `id` nor `name` contains "Obsidian" (guidelines forbid it)
- [x] `versions.json` mapping plugin versions to minimum app versions
- [x] A release workflow that attaches `main.js`, `manifest.json` and
      `styles.css`, and refuses to publish if the tag and the manifest version
      disagree

Still to do by hand:

- [ ] Cut a real release (see below)
- [ ] Open the PR against `obsidianmd/obsidian-releases`

## Cutting a release

The tag must equal the manifest version **exactly, with no `v` prefix** — the
submission bot rejects `v1.0.0`.

```bash
# bump apps/plugin/manifest.json and versions.json first, then:
git tag 1.0.0
git push origin 1.0.0
```

`.github/workflows/plugin-release.yml` then builds, runs the tests, checks the
bundle still requires nothing but `obsidian`, and publishes the release with
the three files attached.

## The submission PR

1. Fork [`obsidianmd/obsidian-releases`](https://github.com/obsidianmd/obsidian-releases).
2. Append an entry to the **end** of `community-plugins.json`:

   ```json
   {
     "id": "vault-relay",
     "name": "Vault Relay",
     "author": "Thomas Royle",
     "description": "Sync your vault with your own self-hosted server, on desktop and mobile.",
     "repo": "roylet/obsidiansync"
   }
   ```

   `id`, `name`, `author` and `description` must match `apps/plugin/manifest.json`.

3. Open a PR and fill in the template checklist.

The description has to start with an action statement, use sentence case, stay
under 250 characters, and end with a full stop. The one above does.

## What review tends to ask about

Reviewers look for a handful of recurring problems. Where they apply, this
plugin already avoids them:

- **No `innerHTML`/`outerHTML`** — the settings tab is built with the `Setting`
  API only.
- **No `var`, and no casting away types.**
- **Detached listeners and timers** — everything goes through
  `registerEvent`, `registerInterval` and `registerDomEvent`, so Obsidian
  tears it down on unload.
- **No `app` global** — `this.app` throughout.
- **Paths built with `normalizePath`.**
- **Mobile compatibility** — no Node APIs; networking is `requestUrl`, not
  `fetch`.

Two things a reviewer may reasonably raise:

- **`styles.css` is nearly empty.** It is still shipped because the release
  guidance expects it, and it holds the one status-bar rule.
- **The plugin talks to a server the user runs.** There is no hosted service
  and no telemetry; the only network destination is the URL the user enters.
  Worth stating plainly in the PR description.

Review usually takes a few weeks. `docs/installing-the-plugin.md` documents
BRAT installation in the meantime.
