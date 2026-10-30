import { describe, expect, it, vi } from 'vitest';
import { atlasHeadingOf, formatAtlasHeading, type AtlasHeading } from './atlasHeading';

const heading = (
  id: string,
  fallback: string,
  arguments_: Record<string, string> = {},
): AtlasHeading => ({
  id,
  args: arguments_,
  fallback,
});

describe('Atlas shelf headings', () => {
  it('keeps English on the fallback-only fast path', () => {
    const phrase = vi.fn((value: string) => `translated ${value}`);
    expect(
      formatAtlasHeading(
        heading('category.genre', 'Drama Movies', {
          label: 'Drama',
          media_type: 'movie',
        }),
        'en',
        phrase,
      ),
    ).toBe('Drama Movies');
    expect(phrase).not.toHaveBeenCalled();
  });

  it('formats the stable fixed, recommendation and person registries in Spanish and Swedish', () => {
    expect(formatAtlasHeading(heading('shelf.trending_week', 'Trending This Week'), 'es')).toBe(
      'Tendencias de esta semana',
    );
    expect(formatAtlasHeading(heading('shelf.trending_week', 'Trending This Week'), 'sv')).toBe(
      'Trendigt den här veckan',
    );
    const because = heading('recommendation.because_watched', 'Because you watched Arrival', {
      title: 'Arrival',
    });
    expect(formatAtlasHeading(because, 'es')).toBe('Porque viste Arrival');
    expect(formatAtlasHeading(because, 'sv')).toBe('Eftersom du tittade på Arrival');
    const person = heading(
      'person.more_from',
      'More from Greta Gerwig — because you watched Barbie',
      {
        name: 'Greta Gerwig',
        watched_title: 'Barbie',
      },
    );
    expect(formatAtlasHeading(person, 'es')).toBe('Más de Greta Gerwig — porque viste Barbie');
    expect(formatAtlasHeading(person, 'sv')).toBe(
      'Mer från Greta Gerwig — eftersom du tittade på Barbie',
    );
  });

  it('localizes authored category labels but preserves external labels verbatim', () => {
    const phrase = (value: string) => (value === 'Dark Comedy' ? 'Comedia negra' : value);
    expect(
      formatAtlasHeading(
        heading('category.genre', 'Dark Comedy Movies', {
          label: 'Dark Comedy',
          media_type: 'movie',
        }),
        'es',
        phrase,
      ),
    ).toBe('Películas de Comedia negra');
    expect(
      formatAtlasHeading(
        heading('external.with_media_type', 'Popular on Netflix Series', {
          label: 'Popular on Netflix',
          media_type: 'tv',
        }),
        'sv',
        () => 'must not be used',
      ),
    ).toBe('Serier: Popular on Netflix');
  });

  it('formats Atlas catalog ids and preserves the media distinction of mixed service pages', () => {
    const catalog = heading('atlas.catalog.new_on', 'New on Netflix', { service: 'Netflix' });
    expect(formatAtlasHeading(catalog, 'es', undefined, 'movie')).toBe(
      'Novedades en Netflix · Películas',
    );
    expect(formatAtlasHeading(catalog, 'sv', undefined, 'tv')).toBe('Nytt på Netflix · Serier');
    expect(formatAtlasHeading(catalog, 'es')).toBe('Novedades en Netflix');
  });

  it('falls back for unknown ids and known ids missing required arguments', () => {
    expect(formatAtlasHeading(heading('atlas.catalog.future', 'Future Atlas Shelf'), 'es')).toBe(
      'Future Atlas Shelf',
    );
    expect(
      formatAtlasHeading(heading('recommendation.because_watched', 'Because you watched it'), 'sv'),
    ).toBe('Because you watched it');
    expect(
      formatAtlasHeading(
        heading('atlas.catalog.future', 'Producer fallback'),
        'sv',
        undefined,
        'tv',
        'Legacy title · Series',
      ),
    ).toBe('Legacy title · Series');
  });

  it('accepts the exact bounded wire shape and rejects malformed or unbounded contracts', () => {
    expect(
      atlasHeadingOf({
        id: 'shelf.watchlist',
        args: {},
        fallback: 'Watchlist',
      }),
    ).toEqual({ id: 'shelf.watchlist', args: {}, fallback: 'Watchlist' });
    expect(atlasHeadingOf({ id: 'shelf.watchlist', fallback: 'Watchlist' })).toBeUndefined();
    expect(
      atlasHeadingOf({ id: 'shelf.watchlist', args: { count: 1 }, fallback: 'Watchlist' }),
    ).toBeUndefined();
    expect(
      atlasHeadingOf({ id: 'x'.repeat(129), args: {}, fallback: 'Future Atlas Shelf' }),
    ).toBeUndefined();
    expect(
      atlasHeadingOf({ id: 'verbatim', args: {}, fallback: 'x'.repeat(1_025) }),
    ).toBeUndefined();
    expect(atlasHeadingOf({ id: 'shelf.watchlist', arguments: {}, fallback: 'Watchlist' })).toEqual(
      { id: 'shelf.watchlist', args: {}, fallback: 'Watchlist' },
    );
  });
});
