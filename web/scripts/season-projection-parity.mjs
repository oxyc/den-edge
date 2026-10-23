import assert from 'node:assert/strict';

/** Exercise the actual shipped adapter, including runtimes built separately from the browser core. */
export function checkSeasonProjection(evaluate, runtime) {
  const at = (time) => [time, 0, 'aaaaaaaaaaaaaaaa'];
  const title = {
    format: 4,
    kind: 'title',
    title: { type: 'tv', id: 1399 },
    episodesReset: at(1500),
  };
  const season = {
    format: 4,
    kind: 'season',
    title: title.title,
    season: 1,
    seasonReset: at(1000),
    episodes: {
      0: { imported: true, plays: {}, cleared: null, progress: null },
      1: {
        imported: false,
        plays: { 1: 2000 },
        cleared: null,
        progress: { value: 0.5, at: at(2500), viewing: 2, seconds: 900 },
      },
      99999: {
        imported: false,
        plays: { 1: 4000 },
        cleared: at(2000),
        progress: null,
      },
      '01': { imported: true },
      100000: { imported: true },
    },
  };
  for (const now of [1200, 3000, 5000]) {
    for (const parent of [undefined, title]) {
      const request = { op: 'season_state_v4', season, now, ...(parent && { title: parent }) };
      const batch = evaluate(request);
      assert.ok(batch.ok, `${runtime}: season_state_v4 must be supported`);
      assert.deepEqual(Object.keys(batch.ok).sort(), ['0', '1', '99999']);
      for (const episode of [0, 1, 99999]) {
        const scalar = evaluate({ ...request, op: 'episode_state_v4', episode });
        assert.ok(scalar.ok, `${runtime}: episode_state_v4 must be supported`);
        assert.deepEqual(batch.ok[episode], scalar.ok, `${runtime}: episode ${episode} at ${now}`);
      }
    }
  }
  for (const value of [undefined, { ...season, episodes: {} }]) {
    const result = evaluate({ op: 'season_state_v4', season: value, now: 3000 });
    assert.deepEqual(result.ok, {}, `${runtime}: absent/empty season`);
  }
}
