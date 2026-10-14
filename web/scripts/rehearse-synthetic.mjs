// The synthetic household `npm run rehearse` seeds when it is given no real data: a library v4 household with the row
// shapes a long-lived one holds. Nothing here is anyone's real library — ids are common TMDB ids, every other value
// is invented, and the key is generated per run.

const DEVICE = 'aaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbb';
const DAY = 86_400_000;

/** `rows(now)`: library rows (wire.ts `Row`s) with every stamp a few days to a few months before `now`. */
export function syntheticRows(now = Date.now(), { legacy = false } = {}) {
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
      'den.audioLanguages': { value: { strings: ['en', 'fi'] }, at: at(60) },
      // Non-default values for personal keys, which the split moves to the Owner library, so Settings after it can
      // be told from defaults. The watch region above is the household's and stays.
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
