/**
 * The active profile's content policy as the content Worker and den-atlas read it.
 *
 * profiles-v1 §5 owns the rules: a title is eligible when its public `minimumAge` is within `maximumAge` (unknown
 * only when `unknownRatings` is `allow`), and a Kid's catalogue is additionally limited to titles made for its
 * audience. den-core decides the age rule (`profile_policy_allows`); den-atlas applies both gates before ranking and
 * pagination when the same fields arrive on a request. This module only translates between the two and keeps one
 * canonical spelling for cache identity.
 *
 * `region` is deliberately not sent. Atlas' store carries one conservative global age, so a region changes no answer
 * today; it would only split every cache by a setting that loads after the first request.
 */

import type { ContentServiceClientPort } from './contentServiceClient';
import type {
  ContentKidAudience,
  ContentPolicy,
  ContentRequest,
  ContentResultFor,
  ContentServiceStatusValue,
} from './contentServiceProtocol';
import type { ProfileContentPolicy } from './profilePolicy';
import { syncPolicy } from './syncCore';
import { ensureSyncPolicy } from './syncLoader';

/** A Kid whose ceiling reaches this age also sees teen-audience titles (profiles-v1 §5). */
const TEEN_AUDIENCE_FROM_AGE = 12;

/** No ceiling, no unknown-rating block and no Kid audience gate: the legacy path, which sends nothing extra. */
export function isRestricted(policy: ContentPolicy | undefined): policy is ContentPolicy {
  return (
    !!policy &&
    (policy.maximumAge !== null || policy.unknownRatings === 'block' || !!policy.kidAudience)
  );
}

/** Whether the policy limits what a direct request (detail, play, download) may open; the audience gate does not. */
export function isAgeRestricted(policy: ContentPolicy | undefined): policy is ContentPolicy {
  return !!policy && (policy.maximumAge !== null || policy.unknownRatings === 'block');
}

export const kidAudienceFor = (maximumAge: number | null): ContentKidAudience =>
  maximumAge === null || maximumAge >= TEEN_AUDIENCE_FROM_AGE ? 'child-or-teen' : 'child';

/**
 * The policy a profile's requests run under, or `undefined` when it has none. A Kid with no readable policy is
 * held to the strictest one rather than none: an unreadable restriction must never open the catalogue.
 */
export function contentPolicyFor(
  policy: ProfileContentPolicy | null,
  kid: boolean,
): ContentPolicy | undefined {
  const base: ProfileContentPolicy = policy ?? {
    maximumAge: kid ? 0 : null,
    unknownRatings: kid ? 'block' : 'allow',
  };
  const effective: ContentPolicy = {
    maximumAge: base.maximumAge,
    unknownRatings: base.unknownRatings,
    ...(kid ? { kidAudience: kidAudienceFor(base.maximumAge) } : {}),
  };
  return isRestricted(effective) ? effective : undefined;
}

/**
 * Stable identity for every cache that holds a policy-dependent answer. `-` is the unrestricted legacy path. Letters,
 * digits, `_` and `-` only, so it can be part of a storage name.
 */
export function policyKey(policy: ContentPolicy | undefined): string {
  if (!isRestricted(policy)) return '-';
  return [policy.maximumAge ?? '-', policy.unknownRatings, policy.kidAudience ?? '-'].join('_');
}

/** The fields den-atlas reads (`maturity::Policy`), in the same order everywhere so a URL has one spelling. */
export function atlasPolicyFields(policy: ContentPolicy | undefined): [string, string][] {
  if (!isRestricted(policy)) return [];
  const fields: [string, string][] = [];
  if (policy.maximumAge !== null) fields.push(['maximumAge', String(policy.maximumAge)]);
  // Atlas defaults an absent `unknownRatings` to `block` beside a ceiling and to `allow` otherwise, so the
  // profile's own choice is always spelled out.
  fields.push(['unknownRatings', policy.unknownRatings]);
  if (policy.kidAudience) fields.push(['kidAudience', policy.kidAudience]);
  return fields;
}

/**
 * Whether a title of this public `minimumAge` (null: unknown) is within the policy: den-core's rule, the same one
 * Apple TV runs. A rule that cannot run (the module failed to load) denies.
 */
export async function ageAllowed(
  policy: ContentPolicy | undefined,
  minimumAge: number | null,
): Promise<boolean> {
  if (!isAgeRestricted(policy)) return true;
  try {
    await ensureSyncPolicy();
    return syncPolicy<boolean>({
      op: 'profile_policy_allows',
      policy: { maximumAge: policy.maximumAge, unknownRatings: policy.unknownRatings },
      minimumAge,
      explicitApproval: false,
    });
  } catch (error) {
    console.error('den: the age policy could not be evaluated; the title stays hidden', error);
    return false;
  }
}

/**
 * A profile's own content port: the household's shared one with this profile's policy on every query. Pages, caches
 * and in-flight reads are keyed by the port they were made on, so a session never shares an answer with another
 * policy, and nothing the page does can ask the Worker an unpoliced question through it.
 */
export class PolicedContent implements ContentServiceClientPort {
  constructor(
    private readonly inner: ContentServiceClientPort,
    private readonly policy: () => ContentPolicy | undefined,
  ) {}

  query<Request extends ContentRequest>(
    request: Request,
    signal?: AbortSignal,
  ): Promise<ContentResultFor<Request>> {
    return this.inner.query(request, signal, this.policy());
  }

  onStatus(listener: (status: ContentServiceStatusValue) => void): () => void {
    return this.inner.onStatus(listener);
  }
}

const ATLAS_UNPOLICED = new Set(['/manifest.json', '/health']);

/**
 * `inner` with the policy on every request to the atlas at `atlas`. GETs carry it in the query (so the browser, den-edge
 * and Cloudflare, which key by URL, hold one answer per policy); the personalised `POST /recommend` carries it in its
 * body. Any other POST has no policy-aware form, so it is refused rather than sent unrestricted.
 */
export function policedAtlasFetch(
  inner: typeof fetch,
  atlas: string,
  policy: ContentPolicy | undefined,
): typeof fetch {
  if (!isRestricted(policy)) return inner;
  const query = new URLSearchParams(atlasPolicyFields(policy)).toString();
  return (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!href.startsWith(`${atlas}/`)) return inner(input, init);
    const route = href.slice(atlas.length).split(/[?#]/)[0]!;
    if (ATLAS_UNPOLICED.has(route)) return inner(input, init);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    if (method === 'POST') {
      if (route !== '/recommend' || typeof init?.body !== 'string')
        return Promise.reject(new Error(`atlas ${route} has no policy-aware form`));
      // The policy overwrites whatever the caller put in the body: a profile cannot ask for a looser one. An
      // undefined `maximumAge` is left out of the JSON, which removes a caller's own.
      const body = JSON.parse(init.body) as Record<string, unknown>;
      return inner(input, {
        ...init,
        body: JSON.stringify({
          ...body,
          maximumAge: policy.maximumAge ?? undefined,
          unknownRatings: policy.unknownRatings,
          kidAudience: policy.kidAudience,
        }),
      });
    }
    const separator = href.includes('?') ? '&' : '?';
    const policed = `${href}${separator}${query}`;
    return inner(input instanceof Request ? new Request(policed, input) : policed, init);
  };
}
