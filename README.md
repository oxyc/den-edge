# den-edge

Den's sync relay, on the homelab. It relays pairings between an Apple TV and another device, carries a paired
device's sealed messages to the TV, keeps the library's record log and the TV's encrypted backup, and holds the
plugin list and settings older links shared. It also serves the Den web app.

It never interprets what it stores: the log, the backup and the inbox are ciphertext sealed on the devices, and
the rest is small JSON it validates and bounds.

## Routes

| Route | What it does |
|---|---|
| `GET /health` | `{"status":"ok"}` |
| `GET /version` | `{"version"}` |
| `GET /config` | the TV's kill-switch and update gate |
| `GET /metrics` | Prometheus text, behind `METRICS_TOKEN` (404 without it) |
| `POST /pair/new` `{sid}` | a TV opens a pairing session ([den-spec pairing v1](https://github.com/oxyc/den-spec/blob/main/wire/pairing-v1.md)): `{nameplate, expiresAt}` (ten minutes) |
| `POST /pair/open` `{nameplate}` | the joining device gets `{sid}`, once; `409` already opened, `410` unknown or expired |
| `PUT`/`GET /pair/{sid}/{a–d}` `{m}` | the four CPace messages, each written once; `202` until written, `410` once the session is over |
| `DELETE /pair/{sid}` | either side ends a pairing |
| `DELETE /link` | unlinking: the link's inbox, plugins and settings are erased |
| `POST /inbox/append` `{sealed}` | a paired device's sealed message for the TV ([den-spec inbox v1](https://github.com/oxyc/den-spec/blob/main/wire/inbox-v1.md)), kept as it came; a readable one is refused |
| `GET /inbox/drain` | the TV takes the queue: `{messages}`, and it is emptied |
| `DELETE /sync/{id}` | erases a backup an older link or the retired settings backup left |
| `POST /lib/{id}/batch` `{writes: [{k, base, v}]}` | the library record log: each write lands if `base` is the record's current sequence, else comes back as a conflict with the current row — `{head, applied, conflicts}` |
| `GET /lib/{id}/changes?since=&limit=` | the records written after `since`, in sequence order: `{entries, head, more}` |

`POST /pair/open` allows 20 tries a minute from one address (`429` past that).

The link's key goes in the `x-den-link` header, so it stays out of URLs (and so out of logs, proxies and
history). A key in the query string is not read; an append's body `inboxKey` still is, and the header wins.

Bodies are capped at 256 KiB, 2 MiB on a library batch. A method a route doesn't serve is `405`.

## State

One file per key under `DATA_DIR`, in a directory per kind (`inbox/`; `plugins/`, `settings/` and `sync/` hold
what retired routes left, erased as its links go),
named by the key's SHA-256 so no key is a file name. Writes go to a temporary file, are synced, and are
renamed into place, and every read-modify-write — an inbox append, a drain, a versioned write — happens under
one lock. So two messages arriving together are both kept, which Workers KV couldn't promise.

A library is one append-only log under `lib/`: its token's hash, then a line per write, synced before the
answer goes out, replayed into memory on first use and rewritten without superseded lines once they
outnumber the live ones. `/lib` requests carry `x-den-library-token`; the first write sets it. Values are
ciphertext the clients seal and merge.

`DATA_DIR/generation` is a random id minted the first time the store opens. Every `/lib` answer carries it.
Leave it out of backups: a restored store then gets a new one, and a device that read past the snapshot sees
the change, reads the log from the start and writes back what the snapshot lacks (den-spec library-v2 §2).

A queue is kept for a week after its last message; everything else is kept until it is replaced. Pairing
sessions live in memory: a restart costs a pairing in progress, which the TV starts again.

The whole store holds at most `STORE_CAP_BYTES`: a write that would pass it is refused with `507`, so whoever
can reach den-edge can't fill the host's disk. A library holds at most 50,000 rows (`413`).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | the port to listen on |
| `DATA_DIR` | `data` (the image sets `/data`) | where the state lives |
| `STORE_CAP_BYTES` | `1073741824` (1 GiB) | the most the state may take on disk |
| `METRICS_TOKEN` | unset | bearer token for `/metrics`; unset turns it off |
| `WEB_DIR` | unset (the image sets `/web`) | the Den web app's built files, served at `/` — see below |
| `WEB_ORIGINS` | unset | origins a browser may call from (comma-separated) — the Den web app; answers their CORS preflights. Unset sends no CORS headers |
| `TRUSTED_PROXIES` | unset | proxies whose report of the visitor's address counts (comma-separated IPs) — the host running `tailscale serve`, `cloudflared`. Behind one, the per-address pairing limit reads `CF-Connecting-IP`, else the last `X-Forwarded-For` entry; from anyone else those headers are ignored. Unset, every visitor through a proxy shares its limit |
| `LOG_REQUESTS` | off | one line per request: `<METHOD> <route> <status> <ms>ms` — a fixed route label, never a key |

## The Den web app

`web/` is the Den web app (Svelte 5 on Vite), the Apple TV app's screens in a browser. The image builds it
and den-edge serves it at `/` from `WEB_DIR`, beside its API — one origin, so the app needs no CORS. A path
with no file behind it is one of the app's routes and gets the shell; hashed files under `/assets/` are
cached for a year. App routes must not reuse an API path (`/lib`, `/pair`, `/inbox`, `/link`, `/sync`): the API
answers first.

```
cd web && npm install && npm run dev    # Vite on :5173, proxying the API to the homelab den-edge
npm run check && npm test && npm run build
```

`DEN_EDGE=http://localhost:8080 npm run dev` proxies to a local den-edge instead. Installs run with
`--ignore-scripts` in CI and the image.

The library's wire format lives in [den-spec](https://github.com/oxyc/den-spec), checked out at `spec/`
(`git submodule update --init`). `web/src/lib/wire.ts` implements it and its tests load den-spec's vectors,
the same ones the Apple TV app checks itself against.

## Run

```
cargo run                       # http://localhost:8080, state in ./data
cargo test
```

## Deploy

A `v*` tag publishes `ghcr.io/oxyc/den-edge`. The homelab runs it as the `den-edge` Quadlet unit on host
port 8094, with its state at `/var/lib/den/edge-data`, and `den-update` deploys new images (the den repo's
`deploy/`).
