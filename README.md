# Obsidian Sync, self-hosted

Sync one Obsidian vault across iOS, Android, macOS and Windows, through a
server you run yourself. The server keeps a full copy of the vault as ordinary
files, so the machine it runs on doubles as a backup you can open directly.

Two pieces:

- **`apps/server`** — a small Fastify service in Docker. Runs on a NAS, stores
  the vault at `data/vault`, and is reached over a Cloudflare tunnel on your
  own domain.
- **`apps/plugin`** — the *Vault Relay* Obsidian plugin. One bundle, all four
  platforms.

## How it syncs

Every file has a content hash. Each device remembers the hash a file had the
last time it and the server agreed, and every upload names that hash as its
base. The server accepts the write only if it still holds that version, and
otherwise replies `409` — so a change is never silently overwritten by a device
that was working from an older copy.

That recorded hash is also what makes "who changed this?" answerable. Comparing
just two hashes cannot distinguish an incoming edit from a local one; comparing
three tells you which side moved.

**Conflicts never lose work.** If two devices edit the same note while one is
offline, the newer edit keeps the note's real path and the older is saved beside
it as `Note (conflict 2026-08-21 1420 iPhone).md`. Both versions then sync
everywhere, and you decide what to merge.

Devices push their own edits immediately and poll for everyone else's every few
seconds while Obsidian is open, plus on startup and whenever you switch back to
the app. There is no persistent connection to drop, which matters on a phone.

## Getting started

1. **[Run the server](docs/self-hosting.md)** — Docker Compose on your NAS, then
   a Cloudflare tunnel pointed at it.
2. **[Install the plugin](docs/installing-the-plugin.md)** on each device, and
   paste in the server URL and that device's token.

## What gets synced

Notes and attachments, always. The Obsidian config folder — appearance,
hotkeys, snippets, other plugins — is off by default and can be switched on in
settings; per-device window layouts (`workspace.json`) are never synced, because
a phone and a desktop rewrite them constantly and in incompatible ways.

`.git`, `.trash`, `.DS_Store` and similar are always skipped, and you can add
your own ignore patterns.

Filenames are normalised to Unicode NFC, so a note created on macOS is not
treated as a second, different file on Windows and Linux. Names that cannot
exist on every platform (a colon in the name, say) are reported rather than
silently skipped.

## Development

```bash
pnpm install
pnpm -r build
pnpm test
```

The test suite includes convergence tests that run the real sync engine on
simulated devices against a real server in-process — two devices editing the
same note offline, deletes racing edits, a device rejoining after its cursor
expired. That is what stands in for owning four devices.

To work on the plugin against a live vault:

```bash
pnpm --filter @obsidiansync/plugin dev     # rebuilds main.js on change
```

then symlink `apps/plugin` into `<your vault>/.obsidian/plugins/vault-relay`.

### Layout

```
packages/protocol   wire types, hashing, path and ignore rules, conflict naming
apps/server         Fastify + SQLite; the vault lives on disk as real files
apps/plugin         the Obsidian plugin
tests/e2e           two simulated devices against a real server
docker/             Dockerfile and compose stack
```

`packages/protocol` is imported by both sides, so the client and server cannot
disagree about a hash, a path, or what is in scope.

## Security

Each device gets its own bearer token, stored server-side as a scrypt hash and
revocable individually. Failed attempts are throttled per address, since the
endpoint is reachable from the internet through the tunnel.

The server stores the vault unencrypted — that is the point of having a
readable copy on your own hardware. Anyone with access to the box or to a valid
token can read your notes, so treat the tokens like passwords and keep the NAS
itself secure.

## Licence

MIT
