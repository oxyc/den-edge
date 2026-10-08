import {
  activeHomeView,
  continueWithShapes,
  selectActiveHomeSettings,
  selectHomeLibraryView,
  type ActiveHomePayload,
} from './homeLibraryView';
import {
  applyLog,
  ContinueProjector,
  emptyLibrary,
  type ContinueCandidate,
  type Shape,
} from './library';
import { projectDocument } from './libraryV4';
import { ensureSyncPolicy } from './syncLoader';
import {
  isDocument,
  type ConfigValue,
  type DocumentRow,
  type Row,
  type SettingsRow,
  type Stamp,
} from './wire';

const DEVICE = 'aaaaaaaaaaaaaaaa';
const NOW = 1_700_000_000_000;

export interface ActiveHomeFixtureOptions {
  titles: number;
  series: number;
  downloads: number;
}

export const REPRESENTATIVE_HOME_FIXTURE: ActiveHomeFixtureOptions = {
  titles: 5_000,
  series: 1_000,
  downloads: 10,
};

const at = (time: number): Stamp => [time, 0, DEVICE];
const stamped = (value: ConfigValue | null, time: number) => ({ value, at: at(time) });

function titleDocument(type: 'movie' | 'tv', id: number, index: number): DocumentRow {
  const status =
    type === 'tv' ? 'none' : index % 3 === 0 ? 'watched' : index % 3 === 1 ? 'watchlist' : 'none';
  const time = NOW - index * 1_000;
  return {
    format: 4,
    kind: 'title',
    title: { type, id },
    status: { value: status, at: at(time) },
    ...(index % 17 === 0
      ? { reaction: { value: index % 34 === 0 ? 'love' : 'like', at: at(time + 1) } }
      : {}),
    addedAt: time - 1,
  };
}

function seasonDocument(id: number, index: number): DocumentRow {
  const base = NOW - index * 100_000;
  const episodes: Record<string, Record<string, unknown>> = {};
  for (let episode = 1; episode <= 20; episode++) {
    if (episode <= 15) {
      episodes[episode] = {
        imported: false,
        progress: { value: 1, at: at(base + episode), viewing: 0 },
        plays: { 0: base + episode },
        cleared: null,
      };
    } else if (episode === 16) {
      episodes[episode] = {
        imported: false,
        progress: { value: 0.42, seconds: 1_260, at: at(base + 100), viewing: 0 },
        plays: {},
        cleared: null,
      };
    } else {
      episodes[episode] = {
        imported: episode === 17,
        plays: {},
        cleared: null,
      };
    }
  }
  return {
    format: 4,
    kind: 'season',
    title: { type: 'tv', id },
    season: 1,
    seasonReset: null,
    episodes,
  };
}

function setting(name: string, values: SettingsRow['values']): SettingsRow {
  return { kind: 'set', schema: 2, name, values };
}

function settingsRows(downloads: number): SettingsRow[] {
  const rows: SettingsRow[] = [
    setting('keys', {
      tmdb: stamped({ string: 'tmdb-home' }, NOW - 10),
      omdb: stamped({ string: 'detail-only' }, NOW - 9),
      doesthedogdie: stamped({ string: 'detail-only-too' }, NOW - 8),
    }),
    setting('prefs', {
      'den.excludedGenreIDs': stamped({ ints: [27, 99] }, NOW - 20),
      'den.excludedLanguages': stamped({ strings: ['ja', 'ko'] }, NOW - 19),
      'den.hideAnime': stamped({ bool: true }, NOW - 18),
      'den.hideWatched': stamped({ bool: true }, NOW - 17),
      'den.minReleaseYear': stamped({ int: 1995 }, NOW - 16),
      'den.myServicePicks': stamped({ strings: ['8@uy', '9@US', 'invalid'] }, NOW - 15),
      'den.watchRegion': stamped({ string: 'UY' }, NOW - 14),
      'den.autoplay': stamped({ bool: false }, NOW - 13),
    }),
    setting('plugins', {
      'https://plugins.example/z/manifest.json': stamped({ bool: true }, NOW - 30),
      'https://plugins.example/a/manifest.json': stamped({ bool: true }, NOW - 29),
      'https://plugins.example/disabled/manifest.json': stamped({ bool: false }, NOW - 28),
      'http://plugins.example/insecure/manifest.json': stamped({ bool: true }, NOW - 27),
    }),
    setting('addresses', {
      remux: stamped({ string: 'https://home.tail0000.ts.net/' }, NOW - 40),
      scout: stamped({ string: 'https://scout.tail0000.ts.net/' }, NOW - 39),
      public: stamped({ string: 'https://example.com' }, NOW - 38),
    }),
  ];
  for (let index = 0; index < downloads; index++) {
    const id = 200_000 + index;
    rows.push(
      setting(`download:movie:${id}:-1:-1`, {
        release: stamped(
          {
            string: JSON.stringify({
              identity: `release-${index}`,
              label: `Release ${index}`,
              url: `/scout/prepare/${index}`,
            }),
          },
          NOW - 100 - index,
        ),
        title: stamped(
          {
            string: JSON.stringify({
              mediaType: 'movie',
              mediaId: id,
              title: `Download ${index}`,
              posterPath: `/download-${index}.jpg`,
            }),
          },
          NOW - 100 - index,
        ),
        queuedAt: stamped({ int: NOW - index * 10_000 }, NOW - 100 - index),
      }),
    );
  }
  return rows;
}

export async function activeHomeFixture(options: ActiveHomeFixtureOptions) {
  if (options.series > options.titles) throw new Error('series must not exceed titles');
  await ensureSyncPolicy();

  const tvDocuments = Array.from({ length: options.series }, (_, index) =>
    titleDocument('tv', 1_000 + index, index),
  );
  const movieDocuments = Array.from({ length: options.titles - options.series }, (_, index) =>
    titleDocument('movie', 100_000 + index, options.series + index),
  );
  const seasons = Array.from({ length: options.series }, (_, index) =>
    seasonDocument(1_000 + index, index),
  );
  const source: Row[] = [
    ...tvDocuments,
    ...movieDocuments,
    ...seasons,
    ...settingsRows(options.downloads),
  ];
  const rows = source.flatMap((row) => (isDocument(row) ? projectDocument(row) : [row]));
  const library = applyLog(emptyLibrary(), rows);
  const view = selectHomeLibraryView(library, rows);
  const payloadView = activeHomeView(view);
  const initial = payloadView.continue;
  const shapes = new Map<string, Shape>(
    view.requiredShapeRefs.map((key) => [
      key,
      { counts: new Map([[1, 20]]), lastAired: { season: 1, episode: 20 } },
    ]),
  );
  const shapeRequest = [...shapes] as Array<[string, Shape]>;
  const exact = continueWithShapes(view, shapeRequest);
  const fullExact = new ContinueProjector().project({ ...library, shapes });
  const payload: ActiveHomePayload = {
    handle: 1,
    stamp: at(NOW),
    reconsiderAt: Infinity,
    at: NOW,
    view: payloadView,
    settings: selectActiveHomeSettings(rows),
  };
  const currentReply = {
    source,
    rows,
    library,
    stamp: at(NOW),
    reconsiderAt: Infinity,
    at: NOW,
  };
  return {
    options,
    source,
    rows,
    library,
    view,
    payload,
    currentReply,
    initial,
    exact,
    fullExact,
    shapeRequest,
  } satisfies {
    initial: ContinueCandidate[];
    exact: ContinueCandidate[];
    fullExact: ContinueCandidate[];
    shapeRequest: Array<[string, Shape]>;
    [key: string]: unknown;
  };
}
