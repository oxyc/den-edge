// Home's billboard, as atlas ranks it: atlas is the only ranker, and this page only draws what it answers. Everyone
// first reads the same cacheable pool for the UTC day (`GET /recommend/<scope>.json`). Behind a switch
// (`memberPostOn`), a browser with a library then asks atlas to rank against the whole of it (`POST /recommend`),
// and that answer takes every slide after the one on screen and is kept for the next visit's first paint.

import type { MediaType, Title } from './library';
import { keepHeroLeadPointer, pointedHeroLeadKey, removeHeroLeadPointer } from './heroLeadPointer';
import type { Prefs } from './prefs';
import { relayFetch } from './relayFetch';
import { ATLAS } from './scout';
import { GUEST_PICKS } from './services';

/** The billboard fills the viewport and TMDB offers these three bounded backdrop widths. */
export const BILLBOARD_IMAGE_SIZES = '100vw';
export const billboardBackdropURL = (path: string, size = 'w1280') =>
  `https://image.tmdb.org/t/p/${size}${path}`;
export const billboardBackdropSrcset = (path: string) =>
  [
    `${billboardBackdropURL(path, 'w300')} 300w`,
    `${billboardBackdropURL(path, 'w780')} 780w`,
    `${billboardBackdropURL(path)} 1280w`,
  ].join(', ');

/** A library title and how much it says about taste, as `Library.svelte` weighs it. */
export interface Weighted {
  ref: { type: MediaType; id: number };
  weight: number;
  at: number;
}

export interface Slide {
  type: MediaType;
  id: number;
  imdbId?: string;
  why?: RecommendationWhy;
}

/** Atlas's scoring diagnostics. The terms are carried intact for inspection; only `reason` is presentation. */
export interface RecommendationWhy {
  score?: number;
  fit?: number;
  similar?: number | null;
  profile?: number;
  people?: number;
  confidence?: number;
  fresh?: number;
  arrived?: number;
  quality?: number;
  buzz?: number;
  /** A stable scorer-selected code. Unknown codes are retained but deliberately have no browser copy. */
  reason?: string;
}

/** A named recommendation, including the explanation Atlas attached to this particular ranking. */
export interface RecommendedTitle extends Title {
  why?: RecommendationWhy;
}

const REASONS: Readonly<Record<string, string>> = {
  similar: 'Similar to what you watch',
  profile: 'Fits your viewing taste',
  people: 'Cast and creators you like',
  franchise: 'From a franchise you like',
  arrived: 'New on streaming',
  recent: 'Recently released',
  upcoming: 'Coming soon',
  timely: 'New or coming soon',
  quality: 'Highly rated',
  buzz: 'Popular now',
};

/** Short billboard copy for Atlas's choice. Missing and newer unknown codes stay silent. */
export const recommendationReason = (why: RecommendationWhy | undefined): string | undefined =>
  why?.reason ? REASONS[why.reason] : undefined;

const WHY_NUMBERS = [
  'score',
  'fit',
  'similar',
  'profile',
  'people',
  'confidence',
  'fresh',
  'arrived',
  'quality',
  'buzz',
] as const;

/** Read every usable diagnostic independently, so one malformed term cannot discard its slide. */
function whyOf(value: unknown): RecommendationWhy | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const why: RecommendationWhy = {};
  for (const field of WHY_NUMBERS) {
    const number = input[field];
    if (typeof number === 'number' && Number.isFinite(number)) why[field] = number;
    else if (field === 'similar' && number === null) why.similar = null;
  }
  if (typeof input.reason === 'string' && input.reason) why.reason = input.reason;
  return Object.keys(why).length ? why : undefined;
}

/** Titles as atlas names them, in Den's names; anything else dropped. */
function slidesOf(value: unknown): Slide[] {
  return (Array.isArray(value) ? (value as Record<string, unknown>[]) : []).flatMap(
    (slide): Slide[] => {
      const type = slide?.type === 'series' ? 'tv' : slide?.type === 'movie' ? 'movie' : null;
      if (!type || typeof slide.id !== 'number') return [];
      const imdbId =
        typeof slide.imdbId === 'string' && /^tt\d+$/.test(slide.imdbId) ? slide.imdbId : undefined;
      return [{ type, id: slide.id, imdbId, why: whyOf(slide.why) }];
    },
  );
}

/** The billboard's scope for the page showing `facet` (Home: null), as `GET /recommend/<scope>.json` names it. */
export const billboardScope = (facet: MediaType | null) =>
  facet === 'movie' ? 'movies' : facet === 'tv' ? 'series' : 'home';

/**
 * Where everyone's billboard for `scope` is asked on `now`'s UTC day, from atlas at `base`; with `fresh`, the one of
 * only new titles (`freshOn`), which atlas ranks and keeps apart.
 */
const everyoneUrl = (base: string, scope: string, fresh: boolean, now: Date) =>
  `${base}/recommend/${scope}.json?day=${now.toISOString().slice(0, 10)}${fresh ? '&fresh=1' : ''}`;

async function askEveryone(url: string, fetchImpl: typeof fetch): Promise<Slide[] | null> {
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const answer = (await res.json()) as { slides?: unknown };
    return Array.isArray(answer.slides) ? slidesOf(answer.slides) : null;
  } catch {
    return null;
  }
}

/** Billboards asked before the app knew it would want them (`startBillboard`), by address, until taken. */
const started = new Map<string, Promise<Slide[] | null>>();

/**
 * Ask for this page's billboard for everyone as the app starts (`main.ts`), before it has found atlas or opened the
 * library: at the address a browser with no library of its own finds atlas at (`findAtlas`'s same-origin `/atlas`).
 * `recommendForEveryone` takes this answer when it asks the same address; if nothing asks, it was one kept GET.
 *
 * Not for a `paired` browser: its library's own atlas install answers at `/atlas/<config>`, which atlas ranks for that
 * install's region and services, so its Home asks that address and this one would be a second billboard nobody reads.
 */
export function startBillboard(
  path: string,
  paired: boolean,
  fresh: boolean,
  now = new Date(),
  fetchImpl: typeof fetch = fetch,
): void {
  const scope =
    path === '/' ? 'home' : path === '/movies' ? 'movies' : path === '/series' ? 'series' : null;
  if (!scope || paired) return;
  const url = everyoneUrl(ATLAS.path, scope, fresh, now);
  started.set(url, askEveryone(url, fetchImpl));
}

/**
 * atlas's billboard for everyone (`GET /recommend/<scope>.json`): no library, so one answer per scope and day, which
 * Cloudflare and the browser keep. The UTC day is in the address so each day is its own answer. Null where atlas can't
 * rank (no route, out of reach, a malformed answer).
 */
export function recommendForEveryone(
  base: string,
  scope: string,
  fresh: boolean,
  now = new Date(),
  fetchImpl: typeof fetch = relayFetch,
): Promise<Slide[] | null> {
  const url = everyoneUrl(base, scope, fresh, now);
  const early = started.get(url);
  started.delete(url);
  return early ?? askEveryone(url, fetchImpl);
}

type SwitchStorage = Pick<Storage, 'getItem' | 'setItem'> | undefined;

/**
 * A billboard switch this browser keeps under `name`, on unless turned off: `?<param>=0` turns it off and
 * `?<param>=1` on again; either is remembered, so the parameter is needed once.
 */
function switchOn(name: string, param: string, search: string, storage: SwitchStorage): boolean {
  const asked = new URLSearchParams(search).get(param);
  try {
    if (asked === '1' || asked === '0') storage?.setItem(name, asked);
    return storage?.getItem(name) !== '0';
  } catch {
    // Storage refused (a private window): the parameter still counts for this page.
    return asked !== '0';
  }
}

/**
 * Whether a browser with a library asks atlas to rank its billboard against its recent library (`POST /recommend`):
 * on by default, `?billboard-post=0` turns it off (kept as `den.billboard.member-post`). Judged on den#161: it put
 * more of what the household went on to add in its top 10 than the shared order, and none of its dislikes near the top.
 */
export const memberPostOn = (
  search = globalThis.location?.search ?? '',
  storage: SwitchStorage = globalThis.localStorage,
) => switchOn('den.billboard.member-post', 'billboard-post', search, storage);

/**
 * Whether the billboard is atlas's pool of only new titles (`fresh`), for the shared GET and the member POST alike:
 * on by default, `?billboard-fresh=0` turns it off (kept as `den.billboard.fresh`).
 */
export const freshOn = (
  search = globalThis.location?.search ?? '',
  storage: SwitchStorage = globalThis.localStorage,
) => switchOn('den.billboard.fresh', 'billboard-fresh', search, storage);

/** What atlas calls a series. */
const atlasType = (type: MediaType) => (type === 'tv' ? 'series' : 'movie');

/**
 * What TMDB said about a library title. atlas reads it only for a title it knows nothing about itself, and keeps
 * none of it: without it, a watched title outside atlas's corpus says nothing about taste.
 */
function hintOf(title: Title) {
  const tmdbRating =
    title.ratingSource === 'tmdb' &&
    typeof title.rating === 'number' &&
    Number.isFinite(title.rating) &&
    title.rating > 0 &&
    title.rating <= 10
      ? title.rating
      : undefined;
  return {
    title: title.title,
    year: title.year,
    releaseDate: title.releaseDate,
    genreIds: title.genreIds,
    originalLanguage: title.originalLanguage,
    countries: title.countries,
    popularity: title.popularity,
    ...(tmdbRating !== undefined
      ? {
          rating: tmdbRating,
          ...(typeof title.votes === 'number' && Number.isInteger(title.votes) && title.votes >= 0
            ? { votes: title.votes }
            : {}),
        }
      : {}),
    adult: title.adult,
    imdbId: title.imdbId,
  };
}

/** The most library and owned titles one request may name (den-atlas `recommend.rs` `MAX_LIBRARY`, `MAX_OWNED`). */
const MAX_LIBRARY = 5000;
const MAX_OWNED = 10_000;

/**
 * How far back the library speaks for taste: the last 180 days. Ranked against the whole history, a household's
 * years-old titles (and a second viewer's) outweighed what it watches now, and the billboard did no better than the
 * shared order (den#161). A library with nothing that recent is sent whole.
 */
const TASTE_WINDOW_MS = 180 * 86_400_000;

/**
 * The request for a billboard ranked against this library, on the page showing `facet` (Home: null). No candidate
 * lists: den-edge adds TMDB's trending and current releases to it (`billboard.rs`), and atlas has its own.
 */
export function recommendBody({
  facet,
  prefs,
  library,
  named = new Map(),
  owned,
  fresh = false,
  now = new Date(),
}: {
  facet: MediaType | null;
  prefs: Prefs;
  library: Weighted[];
  /** The library's titles TMDB has named, by `type:id`. */
  named?: ReadonlyMap<string, Title>;
  /** Every title the library holds, by `type:id`. */
  owned: Set<string>;
  /** Only new titles (`freshOn`). */
  fresh?: boolean;
  now?: Date;
}) {
  const recent = library.filter((title) => title.at >= now.getTime() - TASTE_WINDOW_MS);
  return {
    version: 1,
    surface: billboardScope(facet),
    now: now.toISOString(),
    ...(fresh ? { fresh: true } : {}),
    // Home uses these same six picks until the household saves a selection; a saved empty selection stays empty.
    services: prefs.servicesConfigured ? prefs.services : GUEST_PICKS,
    // Past atlas's limit it would refuse the whole request, so the most recent titles go.
    library: [...(recent.length ? recent : library)]
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_LIBRARY)
      .map(({ ref, weight, at }) => {
        const title = named.get(`${ref.type}:${ref.id}`);
        return {
          type: atlasType(ref.type),
          id: ref.id,
          weight,
          at,
          ...(title ? { hint: hintOf(title) } : {}),
        };
      }),
    owned: [...owned].slice(0, MAX_OWNED).flatMap((key) => {
      const [type, id] = key.split(':');
      const numeric = Number(id);
      return (type === 'movie' || type === 'tv') && Number.isInteger(numeric)
        ? [{ type: atlasType(type), id: numeric }]
        : [];
    }),
    hide: {
      minYear: prefs.minReleaseYear,
      genres: [...prefs.excludedGenres],
      languages: [...prefs.excludedLanguages],
      anime: prefs.hideAnime,
    },
  };
}

/** atlas's billboard for `body`, best first; null where atlas can't rank (no route, out of reach, a malformed answer). */
export async function recommend(
  base: string,
  body: ReturnType<typeof recommendBody>,
  fetchImpl: typeof fetch = relayFetch,
): Promise<Slide[] | null> {
  try {
    const res = await fetchImpl(`${base}/recommend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const answer = (await res.json()) as { slides?: unknown };
    return Array.isArray(answer.slides) ? slidesOf(answer.slides) : null;
  } catch {
    return null;
  }
}

/** A billboard atlas ranked for this library, kept for the next visit (`LibraryLog.keep`), with when it was ranked. */
export interface KeptBillboard {
  at: number;
  titles: RecommendedTitle[];
}

/** A ranking is current for a day, then remains a stale-while-revalidate first paint for at most a week. */
const KEPT_FRESH_MS = 86_400_000;
const KEPT_DISPLAY_MS = 7 * KEPT_FRESH_MS;

/**
 * The bounded, non-interactive copy that may accompany the retained lead artwork before the encrypted billboard
 * opens. It is deliberately presentation-sized rather than a second title database.
 */
export interface PersonalHeroCopy {
  type: MediaType;
  id: number;
  title: string;
  year?: number;
  reason?: string;
  genres?: string[];
  overview?: string;
  runtime?: number;
}

/**
 * The small non-sensitive fragment needed before an encrypted kept billboard can be opened. The storage key is
 * scoped to a digest of the exact library key, page facet and `fresh` mode, so switching any of them cannot warm
 * another household's or another ranking's art. Older `{ at, path }` values remain valid.
 */
const LEAD_PREFIX = 'den.hero-lead.v1';
interface KeptLead {
  at: number;
  path: string;
  copy?: PersonalHeroCopy;
}
type LeadStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined;

const leadScope = (identity: string | null | undefined, facet: MediaType | null, fresh: boolean) =>
  `${identity ?? ''}\0${facet ?? 'all'}\0${fresh ? 'fresh' : 'all'}`;

const backdropPath = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 256 && /^\/[A-Za-z0-9_./-]+$/.test(value);

const boundedText = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string') return;
  const text = value.trim().replace(/\s+/g, ' ');
  return text ? text.slice(0, max) : undefined;
};

type HeroCopyTitle = Pick<RecommendedTitle, 'type' | 'id' | 'title' | 'year' | 'why'>;
type HeroCopyDetail = {
  overview?: string;
  runtime?: number;
  genres?: { name: string }[];
};

/** Reduce a named lead and optional detail to the only plaintext copy the parser-time shell understands. */
export function personalHeroCopy(
  title: HeroCopyTitle | undefined,
  detail?: HeroCopyDetail,
): PersonalHeroCopy | undefined {
  if (
    !title ||
    (title.type !== 'movie' && title.type !== 'tv') ||
    !Number.isInteger(title.id) ||
    title.id <= 0
  )
    return;
  const name = boundedText(title.title, 160);
  if (!name) return;
  const year =
    Number.isInteger(title.year) && title.year! >= 1888 && title.year! <= 2200
      ? title.year
      : undefined;
  const reason = boundedText(recommendationReason(title.why), 100);
  const genres = (detail?.genres ?? [])
    .map((genre) => boundedText(genre?.name, 60))
    .filter((genre): genre is string => !!genre)
    .slice(0, 2);
  const overview = boundedText(detail?.overview, 1024);
  const runtime =
    Number.isInteger(detail?.runtime) && detail!.runtime! > 0 && detail!.runtime! <= 1440
      ? detail!.runtime
      : undefined;
  return {
    type: title.type,
    id: title.id,
    title: name,
    ...(year ? { year } : {}),
    ...(reason ? { reason } : {}),
    ...(genres.length ? { genres } : {}),
    ...(overview ? { overview } : {}),
    ...(runtime ? { runtime } : {}),
  };
}

async function leadKey(identity: string, facet: MediaType | null, fresh: boolean) {
  if (!identity || !globalThis.crypto?.subtle) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  const id = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
  return `${LEAD_PREFIX}.${id}.${fresh ? 'fresh.' : ''}${facet ?? 'all'}`;
}

/** Write the lead only after the encrypted `KeptBillboard` holding the same ranking has landed. */
export async function keepPersonalBackdrop(
  identity: string,
  facet: MediaType | null,
  fresh: boolean,
  path: string | undefined,
  at = Date.now(),
  storage: LeadStorage = globalThis.localStorage,
  copy?: PersonalHeroCopy,
): Promise<void> {
  try {
    const key = await leadKey(identity, facet, fresh);
    if (!key || !storage) return;
    if (!backdropPath(path)) {
      removeHeroLeadPointer(identity, facet, fresh, key, storage);
      return storage.removeItem(key);
    }
    storage.setItem(
      key,
      JSON.stringify({ at, path, ...(copy ? { copy } : {}) } satisfies KeptLead),
    );
    keepHeroLeadPointer(identity, facet, fresh, key, storage);
  } catch {
    // Storage and Web Crypto may be unavailable in a private or constrained browser; normal billboard loading wins.
  }
}

type PendingEnrichment = { path: string; copy: PersonalHeroCopy };
// Detail can arrive before the encrypted replacement has made a lead record to enrich. Keep only the newest
// bounded copy per exact library/facet until that replacement lands; a different lead invalidates it.
const pendingEnrichments = new Map<string, PendingEnrichment>();
// Replacement and enrichment mutate the same plaintext record. One queue closes the clear/save gap and makes their
// invocation order deterministic; failed work never poisons the next mutation.
const leadMutationTails = new Map<string, Promise<void>>();

async function mutateLead(scope: string, mutation: () => Promise<void>): Promise<void> {
  const before = leadMutationTails.get(scope) ?? Promise.resolve();
  const running = before.catch(() => {}).then(mutation);
  leadMutationTails.set(scope, running);
  try {
    await running;
  } finally {
    if (leadMutationTails.get(scope) === running) leadMutationTails.delete(scope);
  }
}

const compatibleDetail = (
  copy: Partial<PersonalHeroCopy> | null | undefined,
  lead: PersonalHeroCopy | undefined,
): Pick<PersonalHeroCopy, 'genres' | 'overview' | 'runtime'> => {
  if (!copy || !lead || copy.type !== lead.type || copy.id !== lead.id) return {};
  const genres = Array.isArray(copy.genres)
    ? copy.genres
        .map((genre) => boundedText(genre, 60))
        .filter((genre): genre is string => !!genre)
        .slice(0, 2)
    : [];
  const overview = boundedText(copy.overview, 1024);
  const runtime =
    Number.isInteger(copy.runtime) && copy.runtime! > 0 && copy.runtime! <= 1440
      ? copy.runtime
      : undefined;
  return {
    ...(genres.length ? { genres } : {}),
    ...(overview ? { overview } : {}),
    ...(runtime ? { runtime } : {}),
  };
};

const withRichCopy = (
  basic: PersonalHeroCopy | undefined,
  ...copies: Array<Partial<PersonalHeroCopy> | null | undefined>
): PersonalHeroCopy | undefined =>
  basic
    ? Object.assign({}, basic, ...copies.map((copy) => compatibleDetail(copy, basic)))
    : undefined;

/** Add detail copy without extending the ranking's display lifetime or changing which retained image it names. */
export async function enrichPersonalBackdrop(
  identity: string | null | undefined,
  facet: MediaType | null,
  fresh: boolean,
  title: RecommendedTitle,
  detail: HeroCopyDetail,
  now = Date.now(),
  storage: LeadStorage = globalThis.localStorage,
): Promise<void> {
  if (!identity || !backdropPath(title.backdropPath) || !storage) return;
  const copy = personalHeroCopy(title, detail);
  if (!copy) return;
  const scope = leadScope(identity, facet, fresh);
  const pending = { path: title.backdropPath, copy };
  pendingEnrichments.set(scope, pending);
  await mutateLead(scope, async () => {
    try {
      const key = await leadKey(identity, facet, fresh);
      const raw = key && storage.getItem(key);
      if (!key) {
        if (pendingEnrichments.get(scope) === pending) pendingEnrichments.delete(scope);
        return;
      }
      if (!raw) return;
      const record = JSON.parse(raw) as Partial<KeptLead> | null;
      const age = now - (record?.at ?? NaN);
      if (
        !record ||
        !backdropPath(record.path) ||
        record.path !== title.backdropPath ||
        !(age >= 0 && age < KEPT_DISPLAY_MS)
      ) {
        if (pendingEnrichments.get(scope) === pending) pendingEnrichments.delete(scope);
        return;
      }
      // Backdrop paths are normally title-specific, but they are not an identity. A stale detail response must
      // never relabel another retained lead merely because TMDB happened to reuse the same artwork path.
      if (record.copy && (record.copy.type !== copy.type || record.copy.id !== copy.id)) return;
      const enriched = withRichCopy(copy, record.copy, copy);
      if (JSON.stringify(record.copy) !== JSON.stringify(enriched))
        storage.setItem(
          key,
          JSON.stringify({ at: record.at!, path: record.path, copy: enriched } satisfies KeptLead),
        );
      if (pendingEnrichments.get(scope) === pending) pendingEnrichments.delete(scope);
    } catch {
      // The hint is opportunistic; the encrypted ranking remains the source of truth.
    }
  });
}

async function clearPersonalBackdrop(
  identity: string,
  facet: MediaType | null,
  fresh: boolean,
  storage: LeadStorage,
): Promise<boolean> {
  try {
    const key = await leadKey(identity, facet, fresh);
    if (key && storage) {
      // The public pointer goes first: interruption may cost a preload, but cannot name the old ranking.
      removeHeroLeadPointer(identity, facet, fresh, key, storage);
      storage.removeItem(key);
    }
    return true;
  } catch {
    return false;
  }
}

// A route can rebuild the same ranking while its previous encrypted keep is still in flight. A queued replacement
// superseded before it starts is skipped, and a newer one always lands last.
const replacementGenerations = new Map<string, number>();
let replacementGeneration = 0;

/**
 * Replace the encrypted ranking and its early hint as one ordered operation. The old hint goes first: a failed save,
 * crash, or refused later localStorage write can then cost a preload, but can never preload the previous ranking.
 */
export async function replacePersonalBillboard(
  identity: string | null | undefined,
  facet: MediaType | null,
  fresh: boolean,
  titles: RecommendedTitle[],
  save: (kept: KeptBillboard) => Promise<unknown>,
  at = Date.now(),
  storage: LeadStorage = globalThis.localStorage,
): Promise<void> {
  const queueKey = leadScope(identity, facet, fresh);
  const generation = ++replacementGeneration;
  replacementGenerations.set(queueKey, generation);
  await mutateLead(queueKey, async () => {
    try {
      if (replacementGenerations.get(queueKey) !== generation) return;
      const lead = titles[0];
      const basic = personalHeroCopy(lead);
      let previous: Partial<KeptLead> | null = null;
      if (identity && storage) {
        const key = await leadKey(identity, facet, fresh);
        const raw = key && storage.getItem(key);
        if (raw) {
          try {
            previous = JSON.parse(raw) as Partial<KeptLead> | null;
          } catch {
            previous = null;
          }
        }
      }
      if (identity && !(await clearPersonalBackdrop(identity, facet, fresh, storage)))
        throw new Error('the previous billboard lead could not be cleared');
      await save({ at, titles });
      if (identity) {
        const pending = pendingEnrichments.get(queueKey);
        await keepPersonalBackdrop(
          identity,
          facet,
          fresh,
          lead?.backdropPath,
          at,
          storage,
          withRichCopy(basic, previous?.copy, pending?.copy),
        );
        pendingEnrichments.delete(queueKey);
      }
    } finally {
      if (replacementGenerations.get(queueKey) === generation)
        replacementGenerations.delete(queueKey);
    }
  });
}

const facetAt = (path: string): MediaType | null | undefined =>
  path === '/' ? null : path === '/movies' ? 'movie' : path === '/series' ? 'tv' : undefined;

/**
 * Start only the exact kept personalized lead's image while the encrypted library is still opening. The billboard's
 * later `Image` joins this browser request/cache entry, so this changes discovery time rather than adding a fetch.
 */
export async function preloadPersonalBackdrop(
  page: string,
  identity: string | null | undefined,
  fresh: boolean,
  enabled: boolean,
  now = Date.now(),
  storage: LeadStorage = globalThis.localStorage,
  start: (url: string, srcset: string, sizes: string) => void = (url, srcset, sizes) => {
    const preload = document.createElement('link');
    preload.rel = 'preload';
    preload.as = 'image';
    preload.fetchPriority = 'high';
    preload.imageSrcset = srcset;
    preload.imageSizes = sizes;
    preload.href = url;
    document.head.append(preload);
  },
): Promise<string | null> {
  const facet = facetAt(page);
  if (!enabled || !identity || facet === undefined) return null;
  try {
    const key = pointedHeroLeadKey(identity, facet, fresh, storage);
    const raw = key && storage?.getItem(key);
    const kept: unknown = raw ? JSON.parse(raw) : null;
    const record = kept as Partial<KeptLead> | null;
    const age = now - (record?.at ?? NaN);
    if (!key || !record || !backdropPath(record.path) || !(age >= 0 && age < KEPT_DISPLAY_MS)) {
      if (key) {
        removeHeroLeadPointer(identity, facet, fresh, key, storage);
        if (raw) storage?.removeItem(key);
      }
      return null;
    }
    const url = billboardBackdropURL(record.path);
    start(url, billboardBackdropSrcset(record.path), BILLBOARD_IMAGE_SIZES);
    return url;
  } catch {
    return null;
  }
}

export interface DisplayableKeptBillboard {
  titles: RecommendedTitle[];
  /** False after 24 hours; the caller still paints it while the already-started Atlas ranking revalidates it. */
  fresh: boolean;
}

/** A personalized first paint for up to seven days, rejecting future clocks and empty/malformed rankings. */
export function displayableKept(
  kept: KeptBillboard | null | undefined,
  now = Date.now(),
): DisplayableKeptBillboard | null {
  if (!kept || typeof kept.at !== 'number' || !Array.isArray(kept.titles)) return null;
  const age = now - kept.at;
  return kept.titles.length && age >= 0 && age < KEPT_DISPLAY_MS
    ? { titles: kept.titles, fresh: age < KEPT_FRESH_MS }
    : null;
}

const slideKey = (slide: Pick<Slide, 'type' | 'id'>) => `${slide.type}:${slide.id}`;

/**
 * `next` in place of every slide after `visible`, the one on screen. It and the slides before it stay where they
 * are, so nothing moves under the viewer and the rail keeps its place; `next` follows, less what they already show.
 * With nothing on screen, `next` is the whole billboard.
 */
export function swapAfter<T extends Pick<Slide, 'type' | 'id'>>(
  shown: T[],
  visible: Pick<Slide, 'type' | 'id'> | undefined,
  next: T[],
): T[] {
  const at = visible ? shown.findIndex((slide) => slideKey(slide) === slideKey(visible)) : -1;
  const kept = shown.slice(0, at + 1);
  const keys = new Set(kept.map(slideKey));
  return [...kept, ...next.filter((slide) => !keys.has(slideKey(slide)))];
}

/**
 * The slides as titles to draw, in atlas's order. A title one of the offered lists already named is taken from there;
 * the rest — atlas's own lists name titles by id — are looked up, `lookups` at a time. One TMDB can't name is left
 * out rather than drawn blank.
 */
export async function nameSlides(
  slides: Slide[],
  known: Map<string, Title>,
  lookup: (ref: { type: MediaType; id: number }) => Promise<Title | null>,
  lookups: number,
): Promise<RecommendedTitle[]> {
  const named = new Map<string, Title>();
  const queue = slides.filter((slide) => !known.has(`${slide.type}:${slide.id}`));
  const work = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const title = await lookup({ type: next.type, id: next.id }).catch(() => null);
      if (title) named.set(`${next.type}:${next.id}`, title);
    }
  };
  await Promise.all(Array.from({ length: lookups }, work));
  return slides.flatMap((slide) => {
    const key = `${slide.type}:${slide.id}`;
    const title = known.get(key) ?? named.get(key);
    return title ? [{ ...title, imdbId: title.imdbId ?? slide.imdbId, why: slide.why }] : [];
  });
}
