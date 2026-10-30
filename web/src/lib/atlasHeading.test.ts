import { describe, expect, it, vi } from 'vitest';
import { atlasHeadingOf, formatAtlasHeading, type AtlasHeading } from './atlasHeading';
import type { ParameterCatalog, ParameterMessageId } from './messages/parameters';
import { parameters as esParameters } from './messages/parameters/es';
import { parameters as svParameters } from './messages/parameters/sv';
import { sourcePhrases as esPhrases } from './messages/phrases/es';
import { sourcePhrases as svPhrases } from './messages/phrases/sv';

const heading = (
  id: string,
  fallback: string,
  arguments_: Record<string, string> = {},
): AtlasHeading => ({
  id,
  args: arguments_,
  fallback,
});

const formatter =
  (catalog: ParameterCatalog) =>
  (id: ParameterMessageId, _english: string, values: Readonly<Record<string, string | number>>) => {
    let output = catalog[id];
    for (const [name, value] of Object.entries(values))
      output = output.split(`{${name}}`).join(String(value));
    return output;
  };

const es = formatter(esParameters);
const sv = formatter(svParameters);
const identity = (value: string) => value;
const esPhrase = (value: string) => esPhrases[value] ?? value;
const svPhrase = (value: string) => svPhrases[value] ?? value;

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
        es,
      ),
    ).toBe('Drama Movies');
    expect(phrase).not.toHaveBeenCalled();
  });

  it('formats the stable fixed, recommendation and person registries in Spanish and Swedish', () => {
    expect(
      formatAtlasHeading(heading('shelf.trending_week', 'Trending This Week'), 'es', esPhrase, es),
    ).toBe('Tendencias de esta semana');
    expect(
      formatAtlasHeading(heading('shelf.trending_week', 'Trending This Week'), 'sv', svPhrase, sv),
    ).toBe('Populärt den här veckan');
    const because = heading('recommendation.because_watched', 'Because you watched Arrival', {
      title: 'Arrival',
    });
    expect(formatAtlasHeading(because, 'es', identity, es)).toBe('Porque viste Arrival');
    expect(formatAtlasHeading(because, 'sv', identity, sv)).toBe('Eftersom du tittade på Arrival');
    const person = heading(
      'person.more_from',
      'More from Greta Gerwig — because you watched Barbie',
      {
        name: 'Greta Gerwig',
        watched_title: 'Barbie',
      },
    );
    expect(formatAtlasHeading(person, 'es', identity, es)).toBe(
      'Más de Greta Gerwig — porque viste Barbie',
    );
    expect(formatAtlasHeading(person, 'sv', identity, sv)).toBe(
      'Mer från Greta Gerwig — eftersom du tittade på Barbie',
    );
  });

  it('resolves every registered fixed shelf id through the shipped catalogs', () => {
    const fixed = {
      'shelf.continue_watching': 'Continue Watching',
      'shelf.watchlist': 'Watchlist',
      'shelf.your_watchlist': 'Your Watchlist',
      'shelf.trending_week': 'Trending This Week',
      'shelf.trending_movies_week': 'Trending Movies This Week',
      'shelf.trending_series_week': 'Trending Series This Week',
      'shelf.new_releases': 'New Releases',
      'shelf.top_rated_movies': 'Top Rated Movies',
      'shelf.top_rated_series': 'Top Rated Series',
      'shelf.upcoming': 'Upcoming',
      'shelf.coming_soon': 'Coming Soon',
      'shelf.you_might_also_like': 'You Might Also Like',
      'shelf.other_versions': 'Other Versions',
      'shelf.more_like_this': 'More Like This',
      'shelf.more_in_this_world': 'More in This World',
    } as const;
    for (const [id, english] of Object.entries(fixed)) {
      expect(esPhrases[english], `missing Spanish ${english}`).toBeTruthy();
      expect(svPhrases[english], `missing Swedish ${english}`).toBeTruthy();
      expect(formatAtlasHeading(heading(id, 'Wrong fallback'), 'es', esPhrase, es)).toBe(
        esPhrases[english],
      );
      expect(formatAtlasHeading(heading(id, 'Wrong fallback'), 'sv', svPhrase, sv)).toBe(
        svPhrases[english],
      );
    }
  });

  it('localizes authored category labels but preserves external labels verbatim', () => {
    const phrase = esPhrase;
    expect(
      formatAtlasHeading(
        heading('category.genre', 'Dark Comedy Movies', {
          label: 'Dark Comedy',
          media_type: 'movie',
          names_media_type: 'true',
        }),
        'es',
        phrase,
        es,
      ),
    ).toBe('Películas de Comedia negra');
    expect(
      formatAtlasHeading(
        heading('external.with_media_type', 'Popular on Netflix Series', {
          label: 'Popular on Netflix',
          media_type: 'tv',
        }),
        'sv',
        svPhrase,
        sv,
      ),
    ).toBe('Serier: Popular on Netflix');
  });

  it('formats Atlas catalog ids and preserves the media distinction of mixed service pages', () => {
    const catalog = heading('atlas.catalog.new_on', 'New on Netflix', { service: 'Netflix' });
    expect(formatAtlasHeading(catalog, 'es', esPhrase, es, 'movie')).toBe(
      'Novedades en Netflix · Películas',
    );
    expect(formatAtlasHeading(catalog, 'sv', svPhrase, sv, 'tv')).toBe('Nytt på Netflix · Serier');
    expect(formatAtlasHeading(catalog, 'es', identity, es)).toBe('Novedades en Netflix');
    expect(
      formatAtlasHeading(
        heading('atlas.catalog.trending_everywhere', 'Trending Everywhere'),
        'es',
        esPhrase,
        es,
      ),
    ).toBe('Tendencias en todas partes');
    expect(formatAtlasHeading(heading('atlas.catalog.titles', 'Titles'), 'sv', svPhrase, sv)).toBe(
      'Titlar',
    );
  });

  it('formats the remaining registered recommendation and category ids', () => {
    expect(
      formatAtlasHeading(
        heading('recommendation.because_genre', 'Because you watch Mystery', {
          genre: 'Mystery',
        }),
        'es',
        esPhrase,
        es,
      ),
    ).toBe('Porque ves misterio');
    expect(
      formatAtlasHeading(
        heading('category.service_sort', 'Popular', {}),
        'sv',
        (value) => (value === 'Popular' ? 'Populärt' : svPhrase(value)),
        sv,
      ),
    ).toBe('Populärt');
    expect(
      formatAtlasHeading(
        heading('den.verbatim', 'Owner supplied', { value: 'Owner supplied' }),
        'es',
        () => 'must not translate',
        es,
      ),
    ).toBe('Owner supplied');
  });

  it('falls back for unknown ids and known ids missing required arguments', () => {
    expect(
      formatAtlasHeading(heading('atlas.catalog.future', 'Future Atlas Shelf'), 'es', identity, es),
    ).toBe('Future Atlas Shelf');
    expect(formatAtlasHeading(heading('shelf.future', 'Watchlist'), 'es', esPhrase, es)).toBe(
      'Watchlist',
    );
    expect(
      formatAtlasHeading(
        heading('recommendation.because_watched', 'Because you watched it'),
        'sv',
        identity,
        sv,
      ),
    ).toBe('Because you watched it');
    expect(
      formatAtlasHeading(
        heading('atlas.catalog.future', 'Producer fallback'),
        'sv',
        identity,
        sv,
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
    ).toEqual({ id: 'shelf.watchlist', args: { count: 1 }, fallback: 'Watchlist' });
    expect(
      atlasHeadingOf({ id: 'shelf.watchlist', args: { count: 1.5 }, fallback: 'Watchlist' }),
    ).toBeUndefined();
    expect(
      atlasHeadingOf({ id: 'Shelf.Watchlist', args: {}, fallback: 'Watchlist' }),
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
    expect(
      atlasHeadingOf({ id: 'shelf.watchlist', args: {}, fallback: 'Watchlist', locale: 'sv' }),
    ).toBeUndefined();
    expect(
      atlasHeadingOf({
        id: 'shelf.watchlist',
        args: {},
        arguments: {},
        fallback: 'Watchlist',
      }),
    ).toBeUndefined();
    expect(atlasHeadingOf('Continue Watching')).toEqual({
      id: 'den.legacy',
      args: {},
      fallback: 'Continue Watching',
    });
  });
});
