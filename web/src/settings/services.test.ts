import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentServiceClientPort } from '../lib/contentServiceClient';
import { forgetReused } from '../lib/reuse';
import {
  beginServiceDirectoryLoad,
  canonicalProviderName,
  completeServiceDirectoryLoad,
  contentServices,
  contentServicesResult,
  countriesFrom,
  failServiceDirectoryLoad,
  matches,
  mergeServices,
  serviceLabel,
  servicesFrom,
} from './services';

describe('service directory', () => {
  beforeEach(forgetReused);

  it('folds tier and channel variants onto one service', () => {
    expect(canonicalProviderName('Netflix Standard with Ads')).toBe('netflix');
    expect(canonicalProviderName('Max Amazon Channel')).toBe('max');
    expect(canonicalProviderName('Paramount+ with Showtime')).toBe('paramount+');
    expect(canonicalProviderName('Disney Plus')).toBe('disney plus');
  });

  it("orders by the country's own prominence and keeps the variants a pick may name", () => {
    const services = servicesFrom(
      [
        {
          provider_id: 8,
          provider_name: 'Netflix',
          display_priority: 1,
          display_priorities: { SE: 3 },
        },
        { provider_id: 1796, provider_name: 'Netflix basic with Ads', display_priority: 5 },
        {
          provider_id: 76,
          provider_name: 'Viaplay',
          display_priority: 40,
          display_priorities: { SE: 1 },
        },
        { provider_name: 'no id' },
      ],
      'movie',
      'SE',
    );
    expect(services.map((s) => [s.id, s.priority, s.variants])).toEqual([
      [76, 1, []],
      [8, 3, [1796]],
    ]);
    expect(matches(services[1]!, 1796)).toBe(true);
  });

  it('merges movies and series, naming a service that carries only one', () => {
    const movies = servicesFrom(
      [
        { provider_id: 8, provider_name: 'Netflix', display_priority: 2 },
        { provider_id: 2, provider_name: 'Apple TV Store', display_priority: 9 },
      ],
      'movie',
      'FI',
    );
    const series = servicesFrom(
      [
        { provider_id: 8, provider_name: 'Netflix', display_priority: 1 },
        { provider_id: 1773, provider_name: 'SkyShowtime', display_priority: 4 },
      ],
      'tv',
      'FI',
    );
    expect(mergeServices(movies, series).map((s) => [serviceLabel(s), s.priority])).toEqual([
      ['Netflix', 1],
      ['SkyShowtime (series only)', 4],
      ['Apple TV Store (movies only)', 9],
    ]);
  });

  it('normalizes and orders provider regions', () => {
    expect(
      countriesFrom({
        results: [
          { iso_3166_1: 'se', english_name: 'Sweden' },
          { iso_3166_1: 'FI', english_name: 'Finland' },
          { iso_3166_1: 'XYZ', english_name: 'Nowhere' },
        ],
      }),
    ).toEqual([
      { code: 'FI', name: 'Finland' },
      { code: 'SE', name: 'Sweden' },
    ]);
  });

  it('keeps the last useful list through a failure and ignores a stale answer', () => {
    const netflix = servicesFrom(
      [{ provider_id: 8, provider_name: 'Netflix', display_priority: 1 }],
      'movie',
      'FI',
    );
    const first = beginServiceDirectoryLoad(undefined, 1);
    const ready = completeServiceDirectoryLoad(first, 1, { services: netflix, complete: true });
    const retry = beginServiceDirectoryLoad(ready, 2);

    expect(failServiceDirectoryLoad(retry, 2)).toMatchObject({
      services: netflix,
      status: 'failed',
    });
    expect(
      completeServiceDirectoryLoad(retry, 1, { services: [], complete: true }),
      'request 1 cannot erase the newer request 2 state',
    ).toBe(retry);
  });

  it('shares only authoritative directories from the same profile-owned content port', async () => {
    const answer = {
      kind: 'service.directory' as const,
      services: servicesFrom(
        [{ provider_id: 8, provider_name: 'Netflix', display_priority: 1 }],
        'movie',
        'FI',
      ),
      complete: true,
    };
    const port = (complete = true) => {
      const query = vi.fn(async () => ({ ...answer, complete }));
      return {
        query,
        onStatus: () => () => {},
      } as unknown as ContentServiceClientPort & { query: typeof query };
    };
    const first = port();

    await Promise.all([contentServicesResult(first, 'FI'), contentServices(first, 'FI')]);
    expect(first.query, 'the mounted page and its primer join one request').toHaveBeenCalledTimes(
      1,
    );

    const replacement = port();
    await contentServicesResult(replacement, 'FI');
    expect(
      replacement.query,
      'a replacement profile/household port owns a fresh answer',
    ).toHaveBeenCalledTimes(1);

    const partial = port(false);
    await contentServicesResult(partial, 'FI');
    await contentServicesResult(partial, 'FI');
    expect(partial.query, 'a useful partial answer remains shared').toHaveBeenCalledTimes(1);
    await contentServicesResult(partial, 'FI', true);
    expect(
      partial.query,
      'an explicit Retry replaces the shared partial answer',
    ).toHaveBeenCalledTimes(2);
  });
});
