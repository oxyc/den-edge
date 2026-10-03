import { describe, expect, it } from 'vitest';
import { BLOCKED_MESSAGE, playGuard } from './playGuard';

const rated = (certification: string) => ({
  title: 'A Film',
  release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification }] }] },
});
const fetchOf = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

describe('playGuard, the one place every "Play" actually starts from', () => {
  it('refuses nothing when the household has no ceiling — a guest, always', async () => {
    expect(
      await playGuard(
        { type: 'movie', id: 1 },
        { fetchImpl: fetchOf(rated('R')) /* no ceiling */ },
      ),
    ).toBeNull();
  });

  it('allows a title at or under the ceiling', async () => {
    expect(
      await playGuard(
        { type: 'movie', id: 1 },
        { ceiling: 'pg13', fetchImpl: fetchOf(rated('PG-13')) },
      ),
    ).toBeNull();
    expect(
      await playGuard({ type: 'movie', id: 1 }, { ceiling: 'r', fetchImpl: fetchOf(rated('R')) }),
    ).toBeNull();
  });

  it('refuses a title above the ceiling, with the same message Detail shows', async () => {
    expect(
      await playGuard(
        { type: 'movie', id: 1 },
        { ceiling: 'pg13', fetchImpl: fetchOf(rated('R')) },
      ),
    ).toBe(BLOCKED_MESSAGE);
    expect(
      await playGuard(
        { type: 'movie', id: 1 },
        { ceiling: 'r', fetchImpl: fetchOf(rated('NC-17')) },
      ),
    ).toBe(BLOCKED_MESSAGE);
  });

  it('fails closed — refuses — when a ceiling is set and the lookup fails; never looks one up with no ceiling', async () => {
    let asked = false;
    const down = (async () => {
      asked = true;
      return new Response('{}', { status: 401 });
    }) as typeof fetch;
    expect(await playGuard({ type: 'movie', id: 1 }, { ceiling: 'pg13', fetchImpl: down })).toBe(
      BLOCKED_MESSAGE,
    );
    expect(asked).toBe(true);

    asked = false;
    expect(await playGuard({ type: 'movie', id: 1 }, { fetchImpl: down })).toBeNull();
    expect(asked).toBe(false);
  });

  it('reads the household key where it has one, den-edge’s shared proxy key otherwise', async () => {
    const keys: string[] = [];
    const capture = (async (url: string) => {
      keys.push(new URL(url).searchParams.get('api_key')!);
      return new Response(JSON.stringify(rated('PG-13')), { status: 200 });
    }) as typeof fetch;
    await playGuard({ type: 'movie', id: 1 }, { ceiling: 'pg13', fetchImpl: capture });
    await playGuard(
      { type: 'movie', id: 1 },
      { ceiling: 'pg13', tmdbKey: 'household-key', fetchImpl: capture },
    );
    expect(keys).toEqual(['den-proxy', 'household-key']);
  });
});
