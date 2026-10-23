# den-edge

Den's sync relay, on the homelab. It relays pairings between an Apple TV and another device, carries a paired
device's sealed messages to the TV, keeps the library's current encrypted state and the TV's encrypted backup, and
holds the plugin list and settings older links shared. It also serves the Den web app.

It never interprets what it stores: library rows, the backup and the inbox are ciphertext sealed on the devices,
and the rest is small JSON it validates and bounds.

See [Architecture](ARCHITECTURE.md) for the current request and storage flows and
[Performance](PERFORMANCE.md) for delivery paths, resource bounds, and measured results.
See [TV installation](docs/tv-install.md) to install release builds on Android/Google TV, LG webOS, or Samsung
Tizen TVs. Android and LG load Den's hosted TV UI, so ordinary UI updates do not require reinstalling their small
launcher packages.
Android sideloads have no recurring developer expiry. Samsung documents no LG-style countdown; both normally
survive reboots, though a major firmware update can occasionally require reinstalling them.

## Routes

| Route | What it does |
|---|---|
| `GET /health` | `{"status":"ok"}`; always 200. `{"status":"degraded","reason":"public_listener_unavailable"}` with `X-Den-Degraded: public_listener_unavailable` while `PUBLIC_MEDIA_SOCKET` is set and the helper did not answer the last request made of it |
| `GET /version` | `{"version"}` |
| `GET /config` | the TV's kill-switch and update gate. Addresses live in `/routes` alone (den #16) |
| `GET /capabilities/profiles` | `{"enabled":true,"preview":true}` on a web host named in `PROFILES_PREVIEW_HOSTS`, `{"enabled":true}` on one named only in `PROFILES_HOSTS`, otherwise `404`. Always `no-store`; preview wins if a host is accidentally in both lists |
| `GET /routes` | every address for each service, in order — LAN, tailnet, public (`ROUTES`, [den-spec routes-v1](https://github.com/oxyc/den-spec/blob/main/wire/routes-v1.md)) — the whole table on every name, since a client away from home still matches its LAN install URLs against it |
| `GET /metrics` | Prometheus text, behind `METRICS_TOKEN` (404 without it) |
| `POST /pair/new` `{sid}` | a TV opens a pairing session ([den-spec pairing v1](https://github.com/oxyc/den-spec/blob/main/wire/pairing-v1.md)): `{nameplate, expiresAt}` (ten minutes). An address holds at most 10 live sessions (`429` with `Retry-After` past that) — the visitor's address, which behind a proxy is only what `TRUSTED_PROXIES` makes it: with that unset or wrong, every visitor through the proxy has the proxy's address and all of them share the 10 |
| `POST /pair/open` `{nameplate}` | the joining device gets `{sid}`, once; `409` already opened, `410` unknown or expired |
| `PUT`/`GET /pair/{sid}/{a–d}` `{m}` | the four CPace messages, each written once; `202` until written, `410` once the session is over |
| `DELETE /pair/{sid}` | either side ends a pairing |
| `DELETE /link` | unlinking: the link's inbox, plugins and settings are erased |
| `POST /inbox/append` `{sealed}` | a paired device's sealed message for the TV ([den-spec inbox v1](https://github.com/oxyc/den-spec/blob/main/wire/inbox-v1.md)), kept as it came; a readable one is refused |
| `GET /inbox/drain` | the TV takes the queue: `{messages}`, and it is emptied. An unknown or expired queue is `{messages: []}` like an empty one: a queue exists only while messages wait, so there is no way to tell a dead key from a quiet one |
| `POST /inbox/drain` `{keys}` | several queues at once, one per linked device: `{queues: [[…], …]}` in the order of `keys`, each emptied. 1–16 distinct keys, each its own credential as in the header; one malformed key is a `400` and empties nothing. Both drains share one budget of 240 queues per address per minute (`429` with `Retry-After` past it). `?wait=S`: when every queue is empty the drain is held up to S ≤ 25 seconds and answered the moment a message lands in one of them; priced once, held or not; at most 2 held per address and 16 in all, past which it is answered at once |
| `DELETE /sync/{id}` | erases a backup an older link or the retired settings backup left |
| `POST /lib/{id}/batch` `{writes: [{k, base, v}]}` | the transactional library: each write lands if `base` is the record's current sequence, else comes back as a conflict with the current row — `{head, applied, conflicts}`. Budgeted per library (`LIBRARY_WRITE_BURST`, `LIBRARY_WRITE_PER_MINUTE`): over it is `429 rate_limited` with `retry-after` |
| `GET /lib/{id}/changes?since=&limit=&wait=` | the records written after `since`, in sequence order: `{entries, head, more}`. With `wait=S` and nothing after `since` (in the generation the client sent), held up to S ≤ 25 seconds and answered as soon as a write to that library commits — see [docs/LIBRARY_V3.md](docs/LIBRARY_V3.md#held-reads) |
| `/lib/{id}/exclusive-operation[/…]`, `DELETE /lib/{id}` with `x-den-exclusive-attempt` + `x-den-successor` | the exclusive locks of a compound multi-profile key reset (den-spec profiles-v1 §9.1): `GET …/source`, `POST …` (acquire, or a journal-less recovery with `x-den-successor-token`), `GET …/{attempt}` (lookup), `POST …/{attempt}/successor` (the one successor-household commit), `DELETE …/{attempt}` (abort, household only) and the locked `DELETE` that retires a library and releases its lock in one commit. The household's lock record is the authority and no commit spans two libraries; a member lock is void once its household aborted, and den-edge deletes the declared successors of an aborted reset (at startup and on the household's next access). Exact wire 5 for a household and 4 for a profile library. Off with `PROFILE_RESET_ENABLED`: the routes are `404` and the headers on a `DELETE` mean nothing |
| `POST`/`GET /lib/{id}/grants`, `PUT`/`DELETE /lib/{id}/grants/{gid}`, `POST /lib/{id}/grants/{gid}/code` | a library owner's guest grants (oxyc/den#100): invite a named guest (`{name, addons, installs, codeExpiresAt?, accessDays? or accessUntil?, devices?}` → `{gid, code, grant}`, the code shown once), list, edit or extend, revoke, or send the same guest a new link (`{codeExpiresAt?}` → `{code, devicesRaised, grant}`: the old code stops working, a full device list gains one slot up to 5 and then answers `409 devices_full`, an ended grant `409 access_ended`). Authenticated by `x-den-library-member: <id>:<proof>` for the library in the path; at most 10 live grants per library (`409 too_many_grants`). `installs` is one bare base64url config segment per addon, never a URL; a listed `grant` never returns them, only `escrow`: hex SHA-256 of `[[addon, install], …]` in `den, scout, atlas, reel, subtitles` order, so the owner's page rewrites only a grant whose escrow differs |
| `POST /grant/redeem` `{code, secretHash}` | a guest redeems an invite: `{gid, name, addons, expiresAt}`. One `404 invalid_code` for every reason a code fails (a store that fails is a `5xx`, `507` when full, as for every write); idempotent for the same `secretHash`; the access clock starts at the first redeem; throttled per address |
| `POST`/`GET`/`DELETE /recovery` | a library's recovery codes ([den-spec recovery code](https://github.com/oxyc/den-spec/blob/main/wire/recovery-code.md) §5), with `x-den-library-member: <id>:<proof>`: post `{locator, sealed}` (`201 {createdAt}`; `409 locator_taken`, `409 recovery_full` past 4 a library), list `{entries: [{locator, createdAt, opens, lastOpenedAt}]}`, delete `{locator}` → `{deleted}` (idempotent). A locator under another library reads as absent; `DELETE /lib/{id}` deletes that library's entries, ordered against `POST`. 60 an hour per member visitor, counted after the proof |
| `POST /recovery/open` `{locator}` | a new device redeems a code, with no credential: `{sealed}`, or `404 unknown_code`. Counts `opens`. 5 per 10 minutes and 20 a day per visitor — an IPv6 /56, or one IPv4 address, as `TRUSTED_PROXIES` reports it — and 10 a second (burst 20) across everyone; `429` with `Retry-After` past any. Recovery counts in its own table, apart from every other route's; it never evicts, so a flood that fills it refuses recovery's newcomers until its entries expire, and no other route |
| `GET /grant/addons`, `DELETE /grant/{gid}` | with `x-den-grant: <gid>:<secret>`: the guest's virtual installs (`/<addon>/~<gid>`; `410 grant_expired` once access ended), and leaving |
| `PUT`/`DELETE /grant/den-install` | with `x-den-grant`, replace or remove this guest's own sealed combined-Den config. `PUT` takes `{install}` with one base64url path segment. Edge stores it opaquely and never mixes it with the host's shared-addon escrow. Off with `DEN_PLAYBACK_ENABLED`: the route is `404` |
| `POST /grant/library` `{id, tokenHash}` | with `x-den-grant`: the live, redeemed grant reserves the ONE synced library it may start (`id` the library id, `tokenHash` the base64url SHA-256 of its write token). That library's first write then starts it under `NEW_LIBRARIES=members`, and only with that token; the same pair again is `204`, any other is `403 new_libraries_closed`. Revoking, expiring or leaving never touches the library: it is the guest's |
| `POST /grant/device-ticket`, `POST /grant/device` `{ticket, secretHash}` | with `x-den-grant`, a redeemed device asks for a ticket (`{ticket, expiresAt}`: 128 random bits, ten minutes, in memory, three a grant); another device spends it, with the hash of a secret of its own, for a slot in the grant — answered as a redeem, or `409 devices_full {name}` (the ticket is kept) when the grant is at its `devices` limit. One `404 invalid_ticket` otherwise; single use; throttled per address |
| `GET /.well-known/oauth-authorization-server` | the MCP connector's authorization server (oxyc/den#25, `src/oauth.rs`): RFC 8414 metadata — code flow, PKCE S256 only, public clients, `den:search` |
| `POST /oauth/register` | RFC 7591 dynamic registration: `{client_name?, redirect_uris}` (https, or http to loopback) → `{client_id, …}`, `token_endpoint_auth_method: none`. Ten a minute per address; a registration never consented to is reaped after a day, one consented to 30 days after its last consent once no connection is left; a full table (500) drops the oldest never-consented registration rather than refusing |
| `GET /oauth/authorize` | `response_type=code`, `client_id`, `redirect_uri` (a loopback one on any port, RFC 8252), `code_challenge` + `S256`, `state` (≤ 1 KB), `resource?` → `302` to the web app's consent page, `/connect?request=<id>`. Any refusal is Den's own error page (`400`, HTML), never a redirect: before consent a registered redirect is only what some client chose. Waiting requests are capped (1000, 10 a client), the oldest making room |
| `GET /oauth/request/{id}`, `POST /oauth/request/{id}/approve\|deny` | the consent page: `{client, redirectHost, verified}` — `verified` only for claude.ai, chatgpt.com and loopback, since a client names itself anything — then the answer → `{redirect}`, back to the client with a code or `access_denied`. Approving takes `x-den-library-member` (a member) or `x-den-grant` (a guest with a live grant); anyone else is `403` |
| `POST /oauth/token` | `authorization_code` (with the PKCE verifier) or `refresh_token` (with its `client_id`) → `{access_token, refresh_token, expires_in}`. The access token is an EdDSA JWS (`at+jwt`) for `<resource>/mcp`, 15 minutes, never past a guest's end of access. The refresh token rotates; the one it replaced is taken once more within 60 s (a lost answer, retried), and any older one presented ends the session. A guest's invite holds 5 connections at most, a library 50 |
| `POST /oauth/revoke` | RFC 7009: any token the connection was given — its refresh token, one a refresh replaced, or an access token — ends the connection; any other token is answered the same `200` |
| `GET /oauth/connections`, `DELETE /oauth/connections/{sid}` | Settings › Assistants: `{connections: [{sid, client, redirectHost, kind, guest, createdAt, usedAt}]}`; a member sees its library's connections, its guests' included; a guest its own |
| `* /mcp`, `GET /.well-known/oauth-protected-resource[/mcp]` | relayed to den-mcp (the `/mcp` entry of `ADDON_RELAY`), streamed. `/mcp` only for a token whose session still exists and whose member or grant still stands, checked on every call — so a revocation, a revoked or expired grant, or a library key reset stops the next call. At most 32 calls at den-mcp at once, each counted until its answer (a stream included) has ended or gone 30 s without passing anything on, and preflights too (past that a `503` with `Retry-After`). A call's body must arrive within 10 s (`408`) |

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

A library is one independently writable transactional database under `lib/`. Its current key/sequence indexes,
canonical encrypted row fragments, credentials, and head commit atomically; replacing watched/progress state removes
the superseded row in the same transaction, so startup needs no replay. The file reuses freed pages but never shrinks
on its own, so a write compacts it when more than half is free (at most hourly per library, never under a staged
rewrite). A library may hold 32 MiB of keys and values. Old append logs migrate lazily on the first request with a
crash-safe format marker, and are removed 30 days after it. `/lib` requests carry
`x-den-library-token`; the first write sets it. Values remain ciphertext only the clients can open and merge.

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
the change, reads changes from sequence zero and writes back what the snapshot lacks (den-spec library-v2 §2).

A queue is kept for a week after its last message. Expired queues are reclaimed at startup and hourly,
including abandoned links, and their bytes are returned to the shared storage quota. Everything else is kept until it is replaced. Pairing
sessions live in memory: a restart costs a pairing in progress, which the TV starts again.

The whole store holds at most `STORE_CAP_BYTES`: a write that would pass it is refused with `507`, so whoever
can reach den-edge can't fill the host's disk. The inbox, where anyone may start a queue, holds at most a quarter
of it, so a filled inbox leaves the rest for libraries, grants and connections. An address may start 5 libraries a
minute (`429` with `Retry-After` past that). A library holds at most 50,000 rows and a 32 MiB charge
(`413 library_full`). The charge includes twice the key/value byte lengths plus row/map overhead; an episode row
is about 1 KiB of it, a tracker event about 3.6 KiB. A v3 library lives in its own file, so its charge bounds what
it holds, not memory. A legacy (v2) log is replayed into memory, and may charge at most 8 MiB. The
combined legacy-library cache is capped at 16 MiB and 128 libraries; older copies leave memory and reload from
their durable logs. V3 admits 16 concurrently leased per-library databases and retains only two idle handles;
ordinary startup opens none. Log replay is streamed and bounded by the legacy limit. Oversized legacy logs are
preserved on disk and refused, rather than loaded into the 64 MiB container; their owner can still delete
them. Changes pages are bounded by bytes as well as the requested row count, so follow `more` until done.

On Linux, repeatedly served exact files from 64–512 KiB may be copied off the async workers into read-only
anonymous mappings. This avoids per-hit read/copy work without exposing a file-backed mapping to `SIGBUS` if an
inode is truncated. Live mappings share hard limits of 8 MiB and 32 files; active responses retain their mapping,
and budget pressure falls back to ordinary 64 KiB file streaming. Atomic replacements are separate inode
generations. `/metrics` reports fixed mmap outcomes, faults, resident/cached counts and bytes, and the resident
high-water mark.

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
| `STORE_CAP_BYTES` | `1073741824` (1 GiB) | the most the state may take on disk; the inbox a quarter of it |
| `METRICS_TOKEN` | unset | bearer token for `/metrics`; unset turns it off |
| `WEB_DIR` | unset (the image sets `/web`) | the Den web app's built files, served at `/` — see below |
| `TV_WEB_DIR` | unset (the image sets `/tv-web`) | the separately compiled LG/webOS TV app; served only for `TV_WEB_HOSTS` |
| `WEB_ORIGINS` | unset | origins a browser may call from (comma-separated) — the Den web app; answers their CORS preflights. Unset sends no CORS headers |
| `WEB_HOSTS` | unset | the web app's public names (comma-separated, e.g. `d.oxy.fi`; public, so a shared link opens without an account). A request for one gets the web app, `/health`/`/version`, `/routes`, `/config`, the routes the web app calls (`/pair/…`, `/lib/…`, `/grant/…`, `/inbox/append`, `/inbox/drain`) and the MCP connector (`/mcp`, `/oauth/…`, `/.well-known/oauth-…`) — never what only a TV does (unlinking, `/sync`) or `/metrics` |
| `API_HOSTS` | unset | the device API's public names (e.g. `d-api.oxy.fi`, Access bypassed). A request for one gets the device routes and never the web app, which would otherwise be served past Access. A name in neither list (the LAN address, the tailnet's) serves both halves |
| `TV_WEB_HOSTS` | unset | static TV-app public names (e.g. `den-tv.oxy.fi`). These serve only `TV_WEB_DIR`; the build calls the existing `API_HOSTS` origin instead of duplicating backend routes |
| `TV_API_ORIGIN` | unset (the image sets `https://d-api.oxy.fi`) | bare HTTPS device API origin compiled into the hosted TV build, added to that shell's `connect-src` policy |
| `TV_SERVICE_ORIGIN` | unset (the image sets `https://d.oxy.fi`) | existing public web/service origin used by TV addon, metadata and playback-discovery routes |
| `PROFILES_HOSTS` | unset | exact web host names allowed to discover real profiles at `GET /capabilities/profiles`. Unset or empty keeps real mode off everywhere. Every entry must also be in `WEB_HOSTS`; API hosts, LAN/tailnet/unknown names, and other web hosts receive `404` |
| `PROFILES_PREVIEW_HOSTS` | unset | exact web host names allowed to use only the synthetic Owner/Kids/Visitor preview. Preview wins over `PROFILES_HOSTS`; keep real mode unset during this canary. An entry not also in `WEB_HOSTS` enables nothing |
| `PROFILE_RESET_ENABLED` | off | exposes only the compound key reset's `/lib/{id}/exclusive-operation[/…]` routes and its retiring `DELETE` (profiles-v1 §9.1). Off never unlocks a library: a held lock stays in force and refuses ordinary writes. Its sweep hints live in `lib-profile-reset`; hints an older release left in `lib-profile-migration` are still read and cleared |
| `PROFILES_TV` | unset | whether `GET /config` tells the Apple TV to offer profiles, as `features.profiles`. `1`, `true` or `on` sends `true`; `0`, `false` or `off` sends `false`, the explicit rollback signal the TV honours; unset or empty omits the key, which keeps the TV in "unavailable". Any other value stops startup. It does not touch Den Web (that uses `PROFILES_HOSTS`), migration or enrollment |
| `ADDON_RELAY` | unset | `/<prefix>=<LAN origin>` pairs, comma-separated (`/scout=http://192.168.86.193:8080,/atlas=http://192.168.86.193:8081`). The web app asks its addons at `/<prefix>/…` on its own origin and den-edge fetches them at the LAN address: JSON only (GET, HEAD, POST), without the browser's cookies or headers, not on the `API_HOSTS` names. So the browser never holds the Access token, and needs no CORS past Access |
| `ROUTES` | unset | every address for each service, in order: `<service>=<entry> <entry> …;<service>=…`, an entry `[access:]http(s)://host[:port][/path]` (`access:` marks a name behind Cloudflare Access). Served as `GET /routes`; HTTPS media origins are added to the web app policy. On an HTTPS page, a private-LAN HTTP Remux route is attempted with Chrome Local Network Access; public HTTP is still refused. den's `render-env.sh` builds it from four facts (oxyc/den#16) |
| `NEW_LIBRARIES` | `open` | who may start a library. `open`: any first write. `members`: only a device that proves it holds another library here, with `x-den-library-member: <id>:<token>` on its first write, as a TV moving its library to a new key does, or the one library a live guest grant reserved for that library's own key (`POST /grant/library`). So a stranger reaching the public device API can't use den-edge as storage, and neither can a new household (den #21). A store that lost its data needs `open` again for its TVs to write their libraries back. `visitors`: anyone may start a library, as a **visitor's** unless its first write proves a library that is not one (or it is the library a live grant reserved). The tier is recorded in that first write's own transaction; a proof of a visitor's library starts a visitor's, so a visitor household's profile libraries are visitors too. A visitor's library is held to smaller caps (`VISITOR_LIBRARY_MAX_*`) and is never a household for the scout and remux relay, guest grants, assistant connections, title-metadata publishing or the household's provider keys and larger budgets (`library::is_household_member`); it keeps recovery codes and the proof that starts its profile libraries. Libraries that exist when the mode is switched on are households'. Starting is limited per address a minute (as in every mode), per address a day and over the whole day: `429 rate_limited` with `retry-after`, or `503 visitor_libraries_full` with `retry-after` to UTC midnight; a first write over the visitor caps is `413 library_full`. Counted in `den_edge_library_creations_total{tier,outcome}` and `den_edge_visitor_libraries_today` |
| `VISITOR_LIBRARIES_PER_ADDRESS_DAILY_MAX` | `24` | under `NEW_LIBRARIES=visitors`: visitor libraries one address (an IPv4 host, or an IPv6 /64) may start in a day. A household is a few (its own, and one per profile), so this is a handful of households. `0` closes it |
| `VISITOR_LIBRARIES_DAILY_MAX` | `1000` | visitor libraries the whole store starts in a UTC day, past which a start is `503 visitor_libraries_full` until midnight (logged once). `0` closes visitor libraries. Libraries that exist keep working |
| `VISITOR_LIBRARY_MAX_BYTES` | `16777216` | live bytes (keys and sealed values) a visitor's library may hold; household libraries keep 32 MiB. Never raises the household cap |
| `VISITOR_LIBRARY_MAX_ROWS` | `20000` | rows a visitor's library may hold; household libraries keep 50,000 |
| `LIBRARY_WRITE_BURST` | `250` | batches one library may send in a burst before `POST /lib/{id}/batch` answers `429 {"error":"rate_limited"}` with `retry-after`. Clients send a bulk write as back-to-back 200-row batches (a split copies ~6k rows in ~30; a library at its 50,000-row ceiling is 250), so the burst holds the largest legitimate one. The budget is each library's own and counted after the token is proven; migration, key-reset-lock and rewrite routes, `PUT …/member`, `DELETE` and reads never draw on it. Refusals are counted in `den_edge_library_write_throttled_total` and logged once a minute per library |
| `LIBRARY_WRITE_PER_MINUTE` | `120` | batches a minute one library earns back after a burst: 2 a second, well above what edits by hand or a 30-second refresh send, and a fifth of the 10 a second a looping client was sending. `0` turns the budget off |
| `REMUX_EDGE_SECRET` | unset | shared with den-remux (its `EDGE_SECRET`). Set, a grant guest may use the `/remux` control routes and den-edge can end a grant's sessions (`POST /remux/admin/kill`); unset, guests are offered no remux, because remux would count their sessions as the host's |
| `PUBLIC_MEDIA_BASE` | unset | bare HTTPS origin of the public signed-media listener. Public media is never accepted over HTTP |
| `LAN_MEDIA_BASE` | unset | bare origin of the same signed-media listener on the home network. HTTPS works as before; HTTP is accepted only for an RFC 1918 address or non-loopback `*.local` host, so an HTTPS Cast sender can hand the URL directly to a receiver without proxying the video |
| `CAST_ORIGIN` | unset | bare HTTPS origin of the static Den Web Sender page. The sender itself must remain HTTPS even when `LAN_MEDIA_BASE` is HTTP |
| `DEN_PLAYBACK_ENABLED` | off | exposes combined-Den playback and guest-owned Den installs. An enabled playback call is bounded, uncached and sent to Hearth with trusted Edge headers; public callers must be household members or hold the matching live guest grant. `OPTIONS /den/{config}/playback` is the live Web capability probe (`204`, `Allow: POST`); while off the new surface is concealed as `404` |
| `SEGMENTS_KEY` | unset | den-remux's key for asking it to detect an episode's intro and credits (`X-Den-Segments-Key`). `/skipdb/<tt>/<s>/<e>` falls back to remux's `/remux/segments` (through the `/remux` relay) when SkipDB has nothing; set, it also asks remux to scan an episode remux does not know, at most once per episode per 10 minutes. Unset, detected segments are still read but no scan is requested |
| `TRUSTED_PROXIES` | unset | proxies whose report of the visitor's address counts (comma-separated IPs) — the host running `tailscale serve`, `cloudflared`. Behind one, the per-address limits read the last `X-Forwarded-For` entry, and `CF-Connecting-IP` first from an entry written `cf:<ip>` — `cloudflared`'s, since Cloudflare sets that header, while `tailscale serve` is assumed to pass on whatever a peer wrote in it (not measured). The two are told apart by the address they reach den-edge from, so `cloudflared` and `tailscale serve` must connect from different addresses: on one address, the `cf:` entry's trust covers both; from anyone else those headers are ignored. Unset, every visitor through a proxy shares its limit |
| `LOG_REQUESTS` | off | one line per request: `<METHOD> <route> <status> <ms>ms` — a fixed route label, never a key |
| `LOG_IDENTITY` | on | whether a playback report (`/playback/outcome`, `/playback/cast`, `/playback/startup`) logs what was played — the TMDB id and media kind, the release name and size, the chosen audio and subtitle tracks — joinable to the session by the request id den-edge logs anyway. `0` or `false` drops those fields; every other field (event, outcome, reason, durations, rid) is logged either way. The box's journal is RAM-only and reaches only its owner |
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

### Synthetic profile preview canary

Set only `PROFILES_PREVIEW_HOSTS=d.oxy.fi` to serve the synthetic Owner/Kids/Visitor UI on that web host. Keep
`PROFILES_HOSTS` unset: its real-directory mode is a separate capability and is not part of this canary. The
production web bundle accepts preview only from the exact, uncached `{"enabled":true,"preview":true}` answer;
malformed, cacheable or unavailable answers fail closed.

This preview does not read a real profile directory, create a profile library, start or resume household migration,
raise the wire minimum, or filter the catalogue. Kids has no activity library model, Visitor activity is namespaced
to local storage and deleted on its explicit end, and preview preferences remain local. Owner is still the existing
live Owner session, so ordinary Owner actions continue to write the legacy library exactly as they do without the
preview. The preview PIN is `1234`; it is an interaction demo, not a parental-control boundary. An unavailable
cross-tab lock also fails closed instead of entering preview.

## Run

```
cargo run                       # http://localhost:8080, state in ./data
cargo test
```

### Migration rehearsal

`npm run rehearse` (in `web/`) runs the Owner split end to end: the real `den-edge` binary on a temporary copy of the
data (profile migration on, `NEW_LIBRARIES=members`, the household enrolled), serving the built web app, driven by real
Den Web in Chromium. It opens the household, enables Profiles with a PIN, waits for the commit, then reopens a browser
whose storage was snapshotted before the split, with one tab (`REHEARSE_TWO_TABS=1` adds a two-tab pass), and checks that it adopts the committed
household without writing its old rows back. It needs `cargo build --locked` (or `DEN_EDGE_BIN`), `npm run build`, and
Chromium (`npx playwright install chromium`, or an installed Chrome).

```
npm run rehearse                                          # a synthetic household (~6,100 rows) and a generated key
npm run rehearse -- --small                               # the same with a ~30-row household (REHEARSE_SMALL=1)
REHEARSE_DATA=/path/to/edge-data REHEARSE_KEY_FILE=/path/to/key npm run rehearse   # a copy of real data
```

`REHEARSE_DATA` is a copied `DATA_DIR` (`lib/` and `library-v3-index.redb`; an older
`library-v3-index.json` is imported automatically); `REHEARSE_KEY_FILE` holds the household's
base64 library key. Both are read only; the data is copied before anything runs, and neither is ever committed, so keep
real copies outside the repo. Options (env, or `--flag value`): `REHEARSE_PIN` (default `1234`; the Owner PIN if the
household has one), `REHEARSE_SETTLE_SECONDS` (how long each reopen is watched, default 25), `REHEARSE_MAX_BATCHES`
(batch writes tolerated per reopen, default 6), `--keep` (keep the temp dir with the den-edge logs and browser
profiles), `--headed`. `REHEARSE_LEGACY_ROWS=1` adds rows den-core refuses outright to the synthetic household (a
malformed `set:tracker-event:*` row, v3 `wat`/`snt` rows).

It prints PASS/FAIL per check and exits 1 if any fails: the household commits at wire minimum 5, its directory names an
Owner library that holds the activity, the committed household holds no activity (title, season and delivery
documents, `trackers`, `deliver:*`, `handoff:*`, `assistant-applied`, tracker events), and, after each reopen, at most
`REHEARSE_MAX_BATCHES` `POST /lib/:id/batch` reached den-edge and the decrypted household again holds no activity.
Each reopen starts from the committed data (den-edge restarted on a copy, same port), so they do not affect each other.

## Deploy

Main CI builds `ghcr.io/oxyc/den-edge` as an immutable candidate for the exact commit. It tests, probes, and
scans it before recording its digest. The one image also carries the Cast page (`web/cast`, at `/cast`), which
den-edge serves on `CAST_ORIGIN`'s host and only there (`src/cast.rs`). Run
`scripts/release.sh X.Y.Z` to update the release metadata and create `vX.Y.Z` after that exact main CI
passes. The tag workflow verifies and promotes those same digests; it does not rebuild or rerun the suite.
Android/LG launchers and Samsung widgets use intentional, independently versioned release workflows; see
[TV installation](docs/tv-install.md) and [TV packaging](web/tv-packaging/README.md).

The weekly/manual patch workflow still performs a cache-free rebuild of the newest tag so base-image fixes
ship even when application source has not changed. It follows the same probe, scan, signature, and `:latest`
promotion gates. When adopting this pipeline, cut one ordinary release first: tags created before `VERSION`
and the shared Bake graph existed cannot be rebuilt by the new patch job, which fails with that instruction
instead of silently building a mismatched artifact.

The homelab runs den-edge as the `den-edge` Quadlet unit on host port 8094, with state at
`/var/lib/den/edge-data`; `den-update` deploys signed images and preserves its digest pin, live probe, and
rollback path (the den repo's `deploy/`).
