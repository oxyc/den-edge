// The library a browser with no TV kept for itself before households existed, as `npm run rehearse:household` seeds
// it: the v2 rows the app keeps in IndexedDB (`LibraryLog.openLocal`), at the size a long-used browser reaches. Nothing
// here is anyone's real library: ids are synthetic and every value is invented.

const DEVICE = 'cccccccccccccccc';
const DAY = 86_400_000;
const ZERO = [0, 0, ''];

/** Ids the rehearsal's TMDB fixture answers: films from `FILM_BASE`, series from `SERIES_BASE`. */
export const FILM_BASE = 100_000;
export const SERIES_BASE = 200_000;

/**
 * `films` films and `series` series with a watch history: on the watchlist, watched (some rated), half-watched, removed,
 * dismissed from Continue Watching; each series with season 1 watched and season 2 under way; Settings with both
 * household and profile preferences.
 */
export function localLibraryRows(now = Date.now(), { films = 1000, series = 25 } = {}) {
  const at = (minutesAgo) => [now - minutesAgo * 60_000, 0, DEVICE];
  const rows = [];
  const title = (type, id, fields) => ({
    kind: 'rec',
    schema: 2,
    title: { type, id },
    status: { value: 'none', at: ZERO },
    resume: { value: 0, at: ZERO, viewing: 0 },
    reaction: { value: null, at: ZERO },
    deleted: { value: false, at: ZERO },
    dismissed: { value: false, at: ZERO },
    episodesReset: null,
    addedAt: now - 400 * DAY,
    watchedAt: null,
    ...fields,
  });

  for (let i = 0; i < films; i += 1) {
    const id = FILM_BASE + i;
    const when = at(10 + i * 7);
    const kind = i % 10;
    if (kind < 6)
      rows.push(title('movie', id, { status: { value: 'watchlist', at: when }, addedAt: when[0] }));
    else if (kind < 9)
      rows.push(
        title('movie', id, {
          status: { value: 'watched', at: when },
          resume: { value: 1, at: when, viewing: 1 },
          reaction:
            i % 3 === 0
              ? { value: ['like', 'love', 'dislike', 'seen'][i % 4], at: when }
              : { value: null, at: ZERO },
          addedAt: when[0] - DAY,
          watchedAt: when[0],
        }),
      );
    else
      rows.push(
        title('movie', id, {
          status: { value: 'inProgress', at: when },
          resume: { value: 0.3 + (i % 5) / 10, at: when, viewing: 1, seconds: 1800 },
          // One in five of these was dismissed from Continue Watching, one in seven removed from the library.
          dismissed: i % 50 === 9 ? { value: true, at: at(5) } : { value: false, at: ZERO },
          deleted: i % 70 === 69 ? { value: true, at: at(4) } : { value: false, at: ZERO },
          addedAt: when[0] - DAY,
        }),
      );
  }

  for (let j = 0; j < series; j += 1) {
    const id = SERIES_BASE + j;
    rows.push(
      title('tv', id, {
        status: { value: 'inProgress', at: at(3 + j) },
        addedAt: now - (300 + j) * DAY,
      }),
    );
    for (let episode = 1; episode <= 10; episode += 1)
      rows.push({
        kind: 'ep',
        schema: 2,
        title: { type: 'tv', id },
        season: 1,
        episode,
        progress: { value: 1, at: at(2000 + j * 30 + episode), viewing: 1 },
      });
    for (let episode = 1; episode <= 5; episode += 1)
      rows.push({
        kind: 'ep',
        schema: 2,
        title: { type: 'tv', id },
        season: 2,
        episode,
        progress: {
          value: episode < 5 ? 1 : 0.5,
          at: at(100 + j * 30 - episode),
          viewing: 1,
          ...(episode === 5 ? { seconds: 1200 } : {}),
        },
      });
  }

  const text = (value, when) => ({ value: { string: value }, at: when });
  rows.push(
    {
      kind: 'set',
      schema: 2,
      name: 'prefs',
      values: {
        // The household's.
        'den.watchRegion': text('FI', at(5000)),
        // The profile's.
        'den.hideAnime': { value: { bool: true }, at: at(5000) },
        'den.preferredSubtitleLanguage': text('fi', at(4000)),
        'den.preferredAudioLanguage': text('sv', at(4000)),
        'den.autoSkipSegments': { value: { bool: true }, at: at(4000) },
        'den.minReleaseYear': { value: { int: 1990 }, at: at(4000) },
      },
    },
    {
      kind: 'set',
      schema: 2,
      name: 'keys',
      values: { omdb: text('rehearsal-omdb-key', at(6000)) },
    },
    {
      kind: 'set',
      schema: 2,
      name: 'devices',
      values: {
        [DEVICE]: text(
          JSON.stringify({ name: 'Rehearsal browser', kind: 'web', seenAt: now - DAY }),
          at(1440),
        ),
      },
    },
  );
  return rows;
}
