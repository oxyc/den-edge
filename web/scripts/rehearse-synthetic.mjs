// The synthetic household `npm run rehearse` seeds when it is given no real data: a library v4 household with the row
// shapes a long-lived one holds. Nothing here is anyone's real library — ids are common TMDB ids, every other value
// is invented, and the key is generated per run.

const DEVICE = 'aaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbb';
const DAY = 86_400_000;

/** `rows(now)`: library rows (wire.ts `Row`s) with every stamp a few days to a few months before `now`. */
export function syntheticRows(now = Date.now(), { legacy = false, large = false } = {}) {
  const at = (daysAgo, device = DEVICE) => [now - daysAgo * DAY, 0, device];
  const setting = (name, values) => ({ kind: 'set', schema: 2, name, values });
  const text = (value, when) => ({ value: { string: value }, at: when });
  const rows = [];

  const films = [603, 550, 680, 13, 155, 27205, 157336, 438631, 569094, 346698];
  films.forEach((id, i) => {
    rows.push({
      format: 4,
      kind: 'title',
      title: { type: 'movie', id },
      status: { value: i % 3 === 0 ? 'watchlist' : 'watched', at: at(10 + i) },
      reaction: i % 2 === 0 ? { value: 'love', at: at(9 + i) } : { value: null, at: [0, 0, ''] },
      addedAt: now - (200 - i) * DAY,
      watchedAt: i % 3 === 0 ? null : now - (30 + i) * DAY,
    });
  });

  const series = [1399, 66732, 1396, 76479, 95396];
  series.forEach((id, i) => {
    rows.push({
      format: 4,
      kind: 'title',
      title: { type: 'tv', id },
      status: { value: 'inProgress', at: at(5 + i) },
      addedAt: now - (300 - i) * DAY,
    });
    for (let season = 1; season <= 2; season += 1) {
      const episodes = {};
      for (let episode = 1; episode <= 8; episode += 1)
        episodes[episode] = {
          progress: { value: season === 1 ? 1 : 0.4, at: at(4 + episode), viewing: 0 },
          imported: false,
          plays: { 0: now - (4 + episode) * DAY },
          cleared: null,
        };
      rows.push({
        format: 4,
        kind: 'season',
        title: { type: 'tv', id },
        season,
        seasonReset: null,
        episodes,
      });
    }
  });

  if (large) rows.push(...longHistory(now, at, films, series));

  // A tracker account's receipts for one film, as a delivery document.
  rows.push({
    format: 4,
    kind: 'delivery',
    provider: 'simkl',
    account: '42',
    title: { type: 'movie', id: 603 },
    entries: { list: ['in', at(8), [3, 1, OTHER]] },
  });

  rows.push(
    setting('prefs', {
      'den.hideAnime': { value: { bool: true }, at: at(40) },
      'den.watchRegion': text('FI', at(60)),
      'den.myServicePicks': { value: { strings: ['8@FI'] }, at: at(60) },
      'den.audioLanguages': { value: { strings: ['en', 'fi'] }, at: at(60) },
      // Non-default values for every preference, which the split moves to the Owner library (all of `set:prefs` is
      // profile-scoped), so Settings after it can be told from defaults.
      'den.preferredSubtitleLanguage': text('fi', at(50)),
      'den.autoSkipSegments': { value: { bool: true }, at: at(50) },
      'den.excludedLanguages': { value: { strings: ['hi', 'ko'] }, at: at(50) },
      'den.minReleaseYear': { value: { int: 1990 }, at: at(50) },
      'den.preferredAudioLanguage': text('sv', at(50)),
    }),
    setting('keys', {
      'scout.install': text('c3ludGhldGljLWluc3RhbGw', at(90)),
      'tmdb.key': text('', at(90)),
    }),
    setting('devices', {
      [DEVICE]: text(
        JSON.stringify({ name: 'Living room Apple TV', kind: 'tv', seenAt: now - DAY }),
        at(1),
      ),
      [OTHER]: text(JSON.stringify({ name: 'Phone', kind: 'web', seenAt: now - 3 * DAY }), at(3)),
    }),
    setting('trackers', {
      'simkl:42': text(JSON.stringify({ access_token: 'synthetic' }), at(50)),
    }),
    setting('deliver:simkl:42', {
      since: text(JSON.stringify(at(50)), at(50)),
      lease: { value: { strings: [OTHER, '3'] }, at: at(2) },
    }),
    setting('download-lease', { holder: text(OTHER, at(1)) }),
    setting('download:movie:603:-1:-1', {
      release: text(
        JSON.stringify({
          identity: '0123456789abcdef0123456789abcdef01234567',
          label: 'Synthetic.Release.2160p',
          url: 'https://example.invalid/p/ticket',
        }),
        at(2),
      ),
      title: text(
        JSON.stringify({ mediaType: 'movie', mediaId: 603, title: 'Synthetic film' }),
        at(2),
      ),
      queuedAt: { value: { int: now - 2 * DAY }, at: at(2) },
    }),
    setting('deliver:simkl:9', { lease: { value: { strings: ['', '0'] }, at: at(70) } }),
  );

  // Rows den-core's split refuses outright (`legacy_source_row`), so a household holding one cannot be split until
  // they are gone: a malformed tracker-event row (one per explicit action; this value is not an event, the shape a bad
  // write leaves), and the library v3 watch-block and settlement rows from before documents.
  if (!legacy) return rows;
  rows.push(
    setting('tracker-event:00000000-0000-4000-8000-000000000001', {
      event: text('this is not an event', at(6)),
    }),
    {
      kind: 'wat',
      schema: 3,
      title: { type: 'tv', id: 1399 },
      season: 1,
      block: 0,
      seasonReset: null,
      entries: {
        1: {
          imported: false,
          progress: { value: 1, at: at(120), viewing: 0 },
          plays: { 0: now - 120 * DAY },
          cleared: null,
        },
      },
    },
    {
      kind: 'snt',
      schema: 3,
      provider: 'simkl',
      account: '42',
      target: 'wat:tv:1399:1:0',
      entries: {},
    },
  );
  return rows;
}

/**
 * Years of use on top of the rows above, at the size a long-lived household reaches: about 1,900 titles, 1,170
 * seasons and 3,050 tracker receipts (two accounts), some 6,100 rows in all. Ids start above the common ones the
 * small household uses, so nothing collides.
 */
function longHistory(now, at, films, series) {
  const rows = [];
  const filmIds = Array.from({ length: 1_500 }, (_, i) => 100_000 + i);
  const seriesIds = Array.from({ length: 375 }, (_, i) => 200_000 + i);
  filmIds.forEach((id, i) => {
    const watchlist = i % 9 === 0;
    rows.push({
      format: 4,
      kind: 'title',
      title: { type: 'movie', id },
      status: { value: watchlist ? 'watchlist' : 'watched', at: at(20 + (i % 900)) },
      reaction:
        i % 4 === 0 ? { value: 'love', at: at(19 + (i % 900)) } : { value: null, at: [0, 0, ''] },
      addedAt: now - (40 + (i % 1_500)) * DAY,
      watchedAt: watchlist ? null : now - (20 + (i % 900)) * DAY,
    });
  });
  seriesIds.forEach((id, i) => {
    // Most series are finished; a few are still being watched, so Continue Watching has more than a screenful.
    const watching = i % 15 === 0;
    rows.push({
      format: 4,
      kind: 'title',
      title: { type: 'tv', id },
      status: { value: watching ? 'inProgress' : 'watched', at: at(10 + (i % 700)) },
      addedAt: now - (60 + (i % 1_200)) * DAY,
    });
    const seasons = 3 + (i % 3 === 0 ? 1 : 0) - (i % 5 === 0 ? 1 : 0);
    for (let season = 1; season <= seasons; season += 1) {
      const episodes = {};
      for (let episode = 1; episode <= 10; episode += 1)
        episodes[episode] = {
          progress: {
            value: watching && season === seasons ? 0.5 : 1,
            at: at(10 + (i % 700) + episode),
            viewing: 0,
          },
          imported: i % 2 === 0,
          plays: { 0: now - (10 + (i % 700) + episode) * DAY },
          cleared: null,
        };
      rows.push({
        format: 4,
        kind: 'season',
        title: { type: 'tv', id },
        season,
        seasonReset: null,
        episodes,
      });
    }
  });
  // Receipts: every title for one account, and most of them again for a second account connected later.
  const titles = [
    ...[...films, ...filmIds].map((id) => ({ type: 'movie', id })),
    ...[...series, ...seriesIds].map((id) => ({ type: 'tv', id })),
  ];
  const receipt = (account, title, daysAgo) => ({
    format: 4,
    kind: 'delivery',
    provider: 'simkl',
    account,
    title,
    entries: { list: ['in', at(daysAgo), [1, 1, OTHER]] },
  });
  titles.forEach((title, i) => {
    if (!(title.type === 'movie' && title.id === 603))
      rows.push(receipt('42', title, 8 + (i % 400)));
  });
  titles.slice(0, 1_163).forEach((title, i) => rows.push(receipt('7', title, 5 + (i % 300))));
  return rows;
}
