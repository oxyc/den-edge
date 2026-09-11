# den-edge

Den's sync relay, on the homelab. It links a phone to an Apple TV, carries the companion's messages to the
TV, keeps the TV's encrypted library backup, and holds the plugin list and settings the phone and the TV
share. It also serves the companion web page (`/app`).

It never interprets what it stores: the backup is ciphertext sealed on the TV, and the rest is small JSON it
validates and bounds. It replaced a Cloudflare Worker with the same HTTP API, so a TV moves over with a URL
change and one **Back up**.

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
| `POST /link/new` | the older pairing: the TV mints a code, `{code, expiresAt}` (ten minutes) |
| `POST /link/claim` `{code}` | the phone claims it: `{inboxKey}`; `410` unknown or expired, `409` claimed, `429` after 20 tries a minute from one address |
| `GET /link/poll?code=` | the TV polls: `202` pending, then `{status:"claimed", inboxKey}` once |
| `DELETE /link` | unlinking: the link's inbox, plugins and settings are erased |
| `POST /inbox/append` `{message}` or `{sealed}` | a message for the TV: addon, watchlist, play, TMDB key, metadata key or device name — or a paired device's sealed one ([den-spec inbox v1](https://github.com/oxyc/den-spec/blob/main/wire/inbox-v1.md)), kept as it came |
| `GET /inbox/drain` | the TV takes the queue: `{messages}`, and it is emptied |
| `GET`/`DELETE /sync/{id}` | the library backup: `{ciphertext, nonce, version}` |
| `PUT /sync/{id}` `{ciphertext, nonce, baseVersion}` | `{version}`, or `409 {version}` when `baseVersion` is stale |
| `GET`/`PUT /plugins` | the shared addon list: `{addons, version}` |
| `GET`/`PUT /settings` | the shared settings: `{settings, version}` |
| `POST /lib/{id}/batch` `{writes: [{k, base, v}]}` | the library record log: each write lands if `base` is the record's current sequence, else comes back as a conflict with the current row — `{head, applied, conflicts}` |
| `GET /lib/{id}/changes?since=&limit=` | the records written after `since`, in sequence order: `{entries, head, more}` |
| `GET /app/…` | the companion web page |

The link's key goes in the `x-den-link` header, so it stays out of URLs (and so out of logs, proxies and
history). A key in the query string is not read; an append's body `inboxKey` still is, and the header wins.

Bodies are capped at 256 KiB, 4 MB on `/sync`. A method a route doesn't serve is `405`.

## State

One file per key under `DATA_DIR`, in a directory per kind (`inbox/`, `plugins/`, `settings/`, `sync/`),
named by the key's SHA-256 so no key is a file name. Writes go to a temporary file, are synced, and are
renamed into place, and every read-modify-write — an inbox append, a drain, a versioned write — happens under
one lock. So two messages arriving together are both kept, which Workers KV couldn't promise.

A library is one append-only log under `lib/`: its token's hash, then a line per write, synced before the
answer goes out, replayed into memory on first use and rewritten without superseded lines once they
outnumber the live ones. `/lib` requests carry `x-den-library-token`; the first write sets it. Values are
ciphertext the clients seal and merge.

A queue is kept for a week after its last message; everything else is kept until it is replaced. Pending
link codes and pairing sessions live in memory: a restart costs a pairing in progress, which the TV starts
again.

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
| `LOG_REQUESTS` | off | one line per request: `<METHOD> <route> <status> <ms>ms` — a fixed route label, never a key |

## The Den web app

`web/` is the Den web app (Svelte 5 on Vite), the Apple TV app's screens in a browser. The image builds it
and den-edge serves it at `/` from `WEB_DIR`, beside its API — one origin, so the app needs no CORS. A path
with no file behind it is one of the app's routes and gets the shell; hashed files under `/assets/` are
cached for a year. App routes must not reuse an API path (`/settings`, `/plugins`, `/link/…`): the API
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
