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
| `GET /config` | the TV's kill-switch and update gate. Addresses live in `/routes` alone (den #16) |
| `GET /routes` | every address for each service, in order — LAN, tailnet, public (`ROUTES`, [den-spec routes-v1](https://github.com/oxyc/den-spec/blob/main/wire/routes-v1.md)) — the whole table on every name, since a client away from home still matches its LAN install URLs against it |
| `GET /metrics` | Prometheus text, behind `METRICS_TOKEN` (404 without it) |
| `POST /pair/new` `{sid}` | a TV opens a pairing session ([den-spec pairing v1](https://github.com/oxyc/den-spec/blob/main/wire/pairing-v1.md)): `{nameplate, expiresAt}` (ten minutes) |
| `POST /pair/open` `{nameplate}` | the joining device gets `{sid}`, once; `409` already opened, `410` unknown or expired |
| `PUT`/`GET /pair/{sid}/{a–d}` `{m}` | the four CPace messages, each written once; `202` until written, `410` once the session is over |
| `DELETE /pair/{sid}` | either side ends a pairing |
| `DELETE /link` | unlinking: the link's inbox, plugins and settings are erased |
| `POST /inbox/append` `{sealed}` | a paired device's sealed message for the TV ([den-spec inbox v1](https://github.com/oxyc/den-spec/blob/main/wire/inbox-v1.md)), kept as it came; a readable one is refused |
| `GET /inbox/drain` | the TV takes the queue: `{messages}`, and it is emptied. An unknown or expired queue is `{messages: []}` like an empty one: a queue exists only while messages wait, so there is no way to tell a dead key from a quiet one |
| `POST /inbox/drain` `{keys}` | several queues at once, one per linked device: `{queues: [[…], …]}` in the order of `keys`, each emptied. 1–16 distinct keys, each its own credential as in the header; one malformed key is a `400` and empties nothing |
| `DELETE /sync/{id}` | erases a backup an older link or the retired settings backup left |
| `POST /lib/{id}/batch` `{writes: [{k, base, v}]}` | the library record log: each write lands if `base` is the record's current sequence, else comes back as a conflict with the current row — `{head, applied, conflicts}` |
| `GET /lib/{id}/changes?since=&limit=` | the records written after `since`, in sequence order: `{entries, head, more}` |
| `POST`/`GET /lib/{id}/grants`, `PUT`/`DELETE /lib/{id}/grants/{gid}` | a library owner's guest grants (oxyc/den#100): invite a named guest (`{name, addons, installs, codeExpiresAt?, accessDays? or accessUntil?, devices?}` → `{gid, code, grant}`, the code shown once), list, edit or extend, revoke. Authenticated by `x-den-library-member: <id>:<proof>` for the library in the path; at most 10 live grants per library (`409 too_many_grants`). `installs` is one bare base64url config segment per addon, never a URL |
| `POST /grant/redeem` `{code, secretHash}` | a guest redeems an invite: `{gid, name, addons, expiresAt}`. One `404 invalid_code` for every failure; idempotent for the same `secretHash`; the access clock starts at the first redeem; throttled per address |
| `GET /grant/addons`, `DELETE /grant/{gid}` | with `x-den-grant: <gid>:<secret>`: the guest's virtual installs (`/<addon>/~<gid>`; `410 grant_expired` once access ended), and leaving |
| `GET /.well-known/oauth-authorization-server` | the MCP connector's authorization server (oxyc/den#25, `src/oauth.rs`): RFC 8414 metadata — code flow, PKCE S256 only, public clients, `den:search` |
| `POST /oauth/register` | RFC 7591 dynamic registration: `{client_name?, redirect_uris}` (https, or http to loopback) → `{client_id, …}`, `token_endpoint_auth_method: none`. Ten a minute per address; a registration never consented to is reaped after a day, one consented to 30 days after its last consent once no connection is left; a full table (500) drops the oldest never-consented registration rather than refusing |
| `GET /oauth/authorize` | `response_type=code`, `client_id`, `redirect_uri` (a loopback one on any port, RFC 8252), `code_challenge` + `S256`, `state` (≤ 1 KB), `resource?` → `302` to the web app's consent page, `/connect?request=<id>`. Any refusal is Den's own error page (`400`, HTML), never a redirect: before consent a registered redirect is only what some client chose. Waiting requests are capped (1000, 10 a client), the oldest making room |
| `GET /oauth/request/{id}`, `POST /oauth/request/{id}/approve\|deny` | the consent page: `{client, redirectHost, verified}` — `verified` only for claude.ai, chatgpt.com and loopback, since a client names itself anything — then the answer → `{redirect}`, back to the client with a code or `access_denied`. Approving takes `x-den-library-member` (a member) or `x-den-grant` (a guest with a live grant); anyone else is `403` |
| `POST /oauth/token` | `authorization_code` (with the PKCE verifier) or `refresh_token` (with its `client_id`) → `{access_token, refresh_token, expires_in}`. The access token is an EdDSA JWS (`at+jwt`) for `<resource>/mcp`, 15 minutes, never past a guest's end of access. The refresh token rotates; the one it replaced is taken once more within 60 s (a lost answer, retried), and any older one presented ends the session. A guest's invite holds 5 connections at most, a library 50 |
| `POST /oauth/revoke` | RFC 7009 |
| `GET /oauth/connections`, `DELETE /oauth/connections/{sid}` | Settings › Assistants: `{connections: [{sid, client, redirectHost, kind, guest, createdAt, usedAt}]}`; a member sees its library's connections, its guests' included; a guest its own |
| `* /mcp`, `GET /.well-known/oauth-protected-resource[/mcp]` | relayed to den-mcp (the `/mcp` entry of `ADDON_RELAY`), streamed. `/mcp` only for a token whose session still exists and whose member or grant still stands, checked on every call — so a revocation, a revoked or expired grant, or a library key reset stops the next call. At most 32 calls at den-mcp at once (past that a `503` with `Retry-After`) |

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

Guest grants live under `grants/` (mode 0700): one file per grant and an index, holding only SHA-256 hashes of the
invite code and each device's secret, plus the escrow — the host's config segment per shared addon, which is a
bearer copy of their installs. Leave `grants/` out of backups; a restored store simply reissues its invites. A
guest's `x-den-grant` header makes the relay swap `/<addon>/~<gid>/…` for the host's real install (never a member,
a path allowlist, manifests stripped of `denInstallId` and debrid names, never forwarded upstream), and lets
`/remux/health|releases|session` through with `x-den-edge-secret` and `x-den-owner: grant:<gid>`. Access is
checked from the clock on every call. A background sweep asks den-remux to end the sessions of a grant that
was revoked or expired, and reaps its record 30 days later.

The MCP connector's state lives under `oauth/` (mode 0700): each registered client, each connection (session) with
the SHA-256 of its current and previous refresh secret and whom it speaks for (a library and the hash of its member
token, or a grant), and an index. Codes and consent requests live in memory for a minute and ten. Ending a grant
ends its connections; an hourly sweep ends idle ones (30 days) and those whose member or grant no longer stands.

`DATA_DIR/generation` is a random id minted the first time the store opens. Every `/lib` answer carries it.
Leave it out of backups: a restored store then gets a new one, and a device that read past the snapshot sees
the change, reads the log from the start and writes back what the snapshot lacks (den-spec library-v2 §2).

A queue is kept for a week after its last message. Expired queues are reclaimed at startup and hourly,
including abandoned links, and their bytes are returned to the shared storage quota. Everything else is kept until it is replaced. Pairing
sessions live in memory: a restart costs a pairing in progress, which the TV starts again.

The whole store holds at most `STORE_CAP_BYTES`: a write that would pass it is refused with `507`, so whoever
can reach den-edge can't fill the host's disk. A library holds at most 50,000 rows and an 8 MiB memory charge
(`413 library_full`). The charge includes twice the key/value byte lengths plus row/map overhead. The
combined library cache is capped at 16 MiB and 128 libraries; older copies leave memory and reload from
their durable logs. Log replay is streamed and uses the same per-library limit. Oversized legacy logs are
preserved on disk and refused, rather than loaded into the 64 MiB container; their owner can still delete
them. Changes pages are bounded by bytes as well as the requested row count, so follow `more` until done.

The addon relay forwards only `Content-Type`, `Content-Encoding`, `Cache-Control`, `ETag`, `Last-Modified`, `Vary`,
`Server-Timing`, and `X-Den-Degraded` from upstream responses, and only `Content-Type`, `If-None-Match`,
`If-Modified-Since`, and `Accept-Encoding` from the browser, so an addon's `304` and its gzip reach it. Cookies, redirect locations, and upstream CORS permissions stay
behind the relay.
Host classification parses the authority before matching: explicit ports and DNS root dots do not move
a configured public name into the LAN fallback. Malformed or duplicate Host fields are refused.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | the port to listen on |
| `DATA_DIR` | `data` (the image sets `/data`) | where the state lives |
| `STORE_CAP_BYTES` | `1073741824` (1 GiB) | the most the state may take on disk |
| `METRICS_TOKEN` | unset | bearer token for `/metrics`; unset turns it off |
| `WEB_DIR` | unset (the image sets `/web`) | the Den web app's built files, served at `/` — see below |
| `WEB_ORIGINS` | unset | origins a browser may call from (comma-separated) — the Den web app; answers their CORS preflights. Unset sends no CORS headers |
| `WEB_HOSTS` | unset | the web app's public names (comma-separated, e.g. `d.oxy.fi`; public, so a shared link opens without an account). A request for one gets the web app, `/health`/`/version`, `/routes`, `/config`, the routes the web app calls (`/pair/…`, `/lib/…`, `/grant/…`, `/inbox/append`, `/inbox/drain`) and the MCP connector (`/mcp`, `/oauth/…`, `/.well-known/oauth-…`) — never what only a TV does (unlinking, `/sync`) or `/metrics` |
| `API_HOSTS` | unset | the device API's public names (e.g. `d-api.oxy.fi`, Access bypassed). A request for one gets the device routes and never the web app, which would otherwise be served past Access. A name in neither list (the LAN address, the tailnet's) serves both halves |
| `ADDON_RELAY` | unset | `/<prefix>=<LAN origin>` pairs, comma-separated (`/scout=http://192.168.86.193:8080,/atlas=http://192.168.86.193:8081`). The web app asks its addons at `/<prefix>/…` on its own origin and den-edge fetches them at the LAN address: JSON only (GET, HEAD, POST), without the browser's cookies or headers, not on the `API_HOSTS` names. So the browser never holds the Access token, and needs no CORS past Access |
| `ROUTES` | unset | every address for each service, in order: `<service>=<entry> <entry> …;<service>=…`, an entry `[access:]http(s)://host[:port][/path]` (`access:` marks a name behind Cloudflare Access). Served as `GET /routes`; den-remux's https entries are allowed in the web app's `connect-src` and `media-src`. den's `render-env.sh` builds it from four facts (oxyc/den#16) |
| `NEW_LIBRARIES` | `open` | who may start a library. `open`: any first write. `members`: only a device that proves it holds another library here, with `x-den-library-member: <id>:<token>` on its first write, as a TV moving its library to a new key does. So a stranger reaching the public device API can't use den-edge as storage, and neither can a new household (den #21). A store that lost its data needs `open` again for its TVs to write their libraries back |
| `REMUX_EDGE_SECRET` | unset | shared with den-remux (its `EDGE_SECRET`). Set, a grant guest may use the `/remux` control routes and den-edge can end a grant's sessions (`POST /remux/admin/kill`); unset, guests are offered no remux, because remux would count their sessions as the host's |
| `TRUSTED_PROXIES` | unset | proxies whose report of the visitor's address counts (comma-separated IPs) — the host running `tailscale serve`, `cloudflared`. Behind one, the per-address pairing limit reads `CF-Connecting-IP`, else the last `X-Forwarded-For` entry; from anyone else those headers are ignored. Unset, every visitor through a proxy shares its limit |
| `LOG_REQUESTS` | off | one line per request: `<METHOD> <route> <status> <ms>ms` — a fixed route label, never a key |
| `OAUTH_ISSUER` | unset | the MCP connector's authorization server: the public https origin assistants reach `/oauth/…` on — the web app's own name, so the connector URL is `<it>/mcp` and the consent page is on the same origin. With `OAUTH_SIGNING_KEY` it turns `/oauth/…` and `/mcp` on; the startup line prints the public key den-mcp's `TOKEN_PUBLIC_KEYS` must hold |
| `OAUTH_SIGNING_KEY` | unset | the Ed25519 private key that signs access tokens: 32 bytes, unpadded base64url. A secret |
| `OAUTH_RESOURCE` | `OAUTH_ISSUER` | the origin assistants reach `/mcp` on, when it is not the issuer's; tokens are issued for `<it>/mcp` |
| `OAUTH_CONSENT_ORIGIN` | `OAUTH_ISSUER` | where the web app's consent page is, when the issuer is a name that does not serve the web app (the device API's) |

## The Den web app

`web/` is the Den web app (Svelte 5 on Vite), the Apple TV app's screens in a browser. The image builds it
and den-edge serves it at `/` from `WEB_DIR`, beside its API — one origin, so the app needs no CORS. A path
with no file behind it is one of the app's routes and gets the shell; hashed files under `/assets/` are
cached for a year. App routes must not reuse an API path (`/lib`, `/pair`, `/inbox`, `/link`, `/sync`): the API
answers first.

```
cd web && npm install && npm run dev    # Vite on :5173, proxying the API to the homelab den-edge
npm run lint && npm test && npm run build
```

See [web development and CSS conventions](web/README.md) for formatting and lint commands.

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
