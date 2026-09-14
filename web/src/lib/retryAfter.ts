// What a server means when it says "not now": `Retry-After`, either a number of seconds or an HTTP date.
//
// Reading it is the difference between waiting the time you were told and guessing. Everything here guessed —
// a fixed five, ten or twenty seconds — so a refusal that meant "an hour" was met with a knock every few
// seconds until the page was closed, and on a source list each knock costs the addon a real debrid lookup.

/** Never come straight back: a `Retry-After: 0` would otherwise be a hot loop against something already sore. */
const MIN_MS = 1_000;
/**
 * And never disappear for longer than an hour, whatever a header claims. Scout's own busy answer can genuinely
 * mean an hour, so the ceiling has to allow that — but a wrong or hostile value must not park a screen for a
 * day, since nothing here would ever ask again.
 */
const MAX_MS = 60 * 60 * 1_000;

/** Something with headers: a `Response`, or anything standing in for one in a test. */
interface Answered {
  headers: { get(name: string): string | null };
}

/**
 * How long to wait before asking again, from the answer's own `Retry-After`; `fallback` when it says nothing
 * usable. Both forms of the header are read — delta-seconds, and the HTTP date that a cache or a proxy is
 * just as likely to send.
 */
export function retryAfterMs(
  res: Answered,
  fallback: number,
  now: () => number = Date.now,
): number {
  const raw = res.headers.get('retry-after');
  if (!raw) return fallback;
  const trimmed = raw.trim();
  const seconds = Number(trimmed);
  if (trimmed !== '' && Number.isFinite(seconds)) return bounded(seconds * 1_000, fallback);
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? bounded(at - now(), fallback) : fallback;
}

function bounded(ms: number, fallback: number): number {
  if (!Number.isFinite(ms)) return fallback;
  return Math.min(Math.max(ms, MIN_MS), MAX_MS);
}
