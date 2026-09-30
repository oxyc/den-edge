import { describe, expect, it } from 'vitest';
import { parsePrimeFiles, primeEpisodeHint, primeFileKind } from './primeImport';
import { parseDelimitedRows } from './viewingImportCsv';

const watch = `\uFEFF"Deleted from Watch History","Latest Watch Progress","Most Recent Watch Date","Seconds Watched","Title Description","Title Name"
no,"Not Available",2026-06-19T04:13:47Z,3138,"A farm episode, with a
quoted ""description"".",Updating
no,"Not Available",2026-06-14T02:38:10Z,6345,"A film",Goodrich
yes,"Not Available",2026-06-01T00:00:00Z,1200,"Removed",Hidden
`;

const history = `\uFEFF"City","Material Type Description","Playback Start Datetime (UTC)","Seconds Viewed","Title","Video Duration in 1080p","Zipcode"
"""Montevideo""","""Full""",2026-06-19T04:13:36Z,3138,"""Updating-Clarkson's Farm - Season 5""",3200000,"""11700"""
"""Montevideo""","""Feature""",2026-06-14T02:37:00Z,6200,"""Goodrich""",6500000,"""11700"""
"""Montevideo""","""Promo""",2026-06-14T02:36:00Z,2,"""Goodrich""",4000,"""11700"""
`;

describe('shared CSV reader', () => {
  it('reads a BOM, escaped quotes, commas, and embedded newlines', () => {
    const rows = parseDelimitedRows(watch);
    expect(rows).toHaveLength(4);
    expect(rows[1]![4]).toBe('A farm episode, with a\nquoted "description".');
  });
});

describe('Prime export parsing', () => {
  it('recognizes both files by headers rather than filename', () => {
    expect(primeFileKind(watch)).toBe('watchEvents');
    expect(primeFileKind(history)).toBe('viewingHistory');
    expect(primeFileKind('Title,Date\nFilm,1/1/26')).toBeNull();
  });

  it('joins Watch Events to safe movie and episode observations and drops deleted/promotional data', () => {
    const result = parsePrimeFiles([
      { name: 'anything.csv', text: history },
      { name: 'the-other.csv', text: watch },
    ]);
    expect(result.diagnostics).toEqual({
      events: 3,
      deleted: 1,
      invalid: 0,
      unmatched: [],
      ambiguous: [],
    });
    expect(result.viewings).toEqual([
      {
        kind: 'episode',
        title: 'Updating',
        description: 'A farm episode, with a\nquoted "description".',
        rawTitle: "Updating-Clarkson's Farm - Season 5",
        watchedAt: Date.parse('2026-06-19T04:13:47Z'),
        watchedSeconds: 3138,
        durationSeconds: 3200,
        show: "Clarkson's Farm",
        season: 5,
      },
      {
        kind: 'movie',
        title: 'Goodrich',
        description: 'A film',
        rawTitle: 'Goodrich',
        watchedAt: Date.parse('2026-06-14T02:38:10Z'),
        watchedSeconds: 6345,
        durationSeconds: 6500,
      },
    ]);
  });

  it('requires one of each schema and rejects duplicates', () => {
    expect(() => parsePrimeFiles([{ name: 'watch.csv', text: watch }])).toThrow(/both/i);
    expect(() =>
      parsePrimeFiles([
        { name: 'one.csv', text: watch },
        { name: 'two.csv', text: watch },
      ]),
    ).toThrow(/more than one watch events/i);
  });

  it('parses English and localized season suffixes without guessing an absent season', () => {
    expect(primeEpisodeHint('Updating', "Updating-Clarkson's Farm - Season 5")).toEqual({
      show: "Clarkson's Farm",
      season: 5,
    });
    expect(primeEpisodeHint('Episodio 1', 'Episodio 1-Ochocientas palabras - Temporada 1')).toEqual(
      {
        show: 'Ochocientas palabras',
        season: 1,
      },
    );
    expect(primeEpisodeHint('Pilot', 'Pilot-A Show')).toEqual({ show: 'A Show' });
  });
});
