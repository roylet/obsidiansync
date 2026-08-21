# Running the sync server on your NAS

The server keeps a full copy of your vault as ordinary files under `data/vault`.
You can open that folder directly in Obsidian, back it up, or restore from it
with a plain file copy — nothing is stored in a proprietary format.

## 1. Start the server

Copy `docker/docker-compose.yml` onto the NAS and run:

```bash
docker compose up -d
```

That publishes the server on `127.0.0.1:8080` only. Reaching it from your
phone is the tunnel's job (step 3). If you also want to use it over the LAN,
change the port mapping to `"8080:8080"`.

Check it came up:

```bash
curl http://127.0.0.1:8080/v1/health
# {"ok":true,"protocol":1,"version":"0.1.0"}
```

## 2. Mint a token for each device

Every device authenticates with its own bearer token. Separate tokens mean you
can revoke a lost phone without re-pairing everything else.

```bash
docker compose exec obsidian-sync node dist/cli.js token add "iPhone"
```

The token is printed **once**. Only a scrypt hash is stored, so a lost token is
replaced rather than recovered:

```bash
docker compose exec obsidian-sync node dist/cli.js token list
docker compose exec obsidian-sync node dist/cli.js token revoke <id>
```

Other useful commands:

```bash
docker compose exec obsidian-sync node dist/cli.js status    # file count, current seq
docker compose exec obsidian-sync node dist/cli.js devices   # what has connected
```

## 3. Expose it with a Cloudflare tunnel

A tunnel gives you a stable HTTPS hostname without opening a port on your
router, which matters because iOS and Android will be connecting from outside
your network.

1. In the [Cloudflare Zero Trust dashboard](https://one.dash.cloudflare.com),
   go to **Networks → Tunnels → Create a tunnel**, pick **Cloudflared**, and
   name it.
2. Copy the tunnel token it shows you.
3. Add a **public hostname**: pick your domain (e.g.
   `vault.example.com`), set the service to **HTTP** and the URL to
   `obsidian-sync:8080` — the container name, since cloudflared reaches it
   over the compose network.
4. Put the token in a `.env` file next to `docker-compose.yml`:

   ```
   TUNNEL_TOKEN=eyJhIjoi...
   ```

5. Start the tunnel alongside the server:

   ```bash
   docker compose --profile tunnel up -d
   ```

Your server URL is now `https://vault.example.com`. That is what goes into the
plugin settings on each device.

### Two things worth knowing

**Cloudflare caps upload size.** The free plan rejects request bodies over
100 MB, which is why `MAX_FILE_MB` defaults to 100. Raising it above that only
produces uploads that fail at the edge rather than at the server. If you keep
very large attachments in your vault, either upgrade the Cloudflare plan or
sync those over the LAN.

**Add a rate-limit rule.** The endpoint is now on the public internet. The
server throttles repeated bad tokens by itself, but a Cloudflare WAF rate-limit
rule on `/v1/*` keeps that traffic off your NAS entirely. If you want to lock
it down further, Cloudflare Access with a service token in front of the
hostname works, though you will need to add the Access headers to the plugin's
requests.

## Configuration

All settings are environment variables on the `obsidian-sync` service:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Port inside the container |
| `DATA_DIR` | `/data` | Holds `vault/`, `trash/` and `meta.db` |
| `MAX_FILE_MB` | `100` | Largest single file accepted |
| `TRASH_RETENTION_DAYS` | `30` | How long deleted content stays recoverable |
| `LOG_LEVEL` | `info` | `trace`…`error`, or `silent` |
| `BOOTSTRAP_TOKEN` | unset | Mints a first token on an empty database, so a fresh container is usable without an exec. Ignored once any token exists |

## What is on disk

```
data/
  vault/     your vault, as normal files and folders
  trash/     deleted and overwritten versions, keyed by change number
  meta.db    hashes, the change feed, devices and token hashes
```

### Recovering a file

Deleted and overwritten content is kept under `data/trash/<seq>/<path>` for
`TRASH_RETENTION_DAYS`. To restore something, copy it back into the vault from
any synced device — writing directly into `data/vault` is not picked up,
because the server's index only changes when a client pushes.

### Backups

Back up the whole `data/` directory. If you only want the notes, `data/vault`
alone is a complete, openable Obsidian vault.

## Upgrading

```bash
docker compose pull && docker compose up -d
```

The database migrates itself on start. Tokens, devices and history are
preserved.
