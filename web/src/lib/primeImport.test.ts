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
    expect(primeEpisodeHint('Pilot', 'Pilot-A Show S1')).toEqual({ show: 'A Show', season: 1 });
    expect(primeEpisodeHint('Pilot', 'Pilot-A Show, Season #1 (4K UHD)')).toEqual({
      show: 'A Show',
      season: 1,
    });
    expect(primeEpisodeHint('Ep 205 - Das Vergessen', 'Das Vergessen-The Missing')).toEqual({
      show: 'The Missing',
    });
    expect(primeEpisodeHint('Cake', 'Cake: una razón para vivir')).toEqual({});
    expect(
      primeEpisodeHint('Surprise, Motherf**ker!', 'Surprise, Motherf*****!-Dexter Season 7'),
    ).toEqual({ show: 'Dexter', season: 7 });
    expect(
      primeEpisodeHint(
        "Sebastian Fitzek's Therapy - Returning",
        "Sebastian Fitzek's Therapy - Frantic-Sebastian Fitzek's Therapy",
      ),
    ).toEqual({ show: "Sebastian Fitzek's Therapy" });
  });

  it('uses the watch date to separate identical episode names from different shows', () => {
    const sameNames = `"Deleted from Watch History","Most Recent Watch Date","Seconds Watched","Title Description","Title Name"
no,2026-01-01T12:00:00Z,1800,First show,Pilot
no,2026-01-10T12:00:00Z,1800,Second show,Pilot`;
    const sessions = `"Material Type Description","Playback Start Datetime (UTC)","Seconds Viewed","Title","Video Duration in 1080p","City"
Full,2026-01-01T11:59:00Z,1800,Pilot-First Show - Season 1,1800000,Private
Full,2026-01-01T11:00:00Z,20,Pilot-First Show - Season 1,1800000,Private
Full,2026-01-10T11:59:00Z,1800,Pilot-Second Show - Season 2,1800000,Private`;
    const result = parsePrimeFiles([
      { name: 'events.csv', text: sameNames },
      { name: 'history.csv', text: sessions },
    ]);
    expect(result.diagnostics.ambiguous).toEqual([]);
    expect(
      result.viewings.map(({ show, season, durationSeconds }) => ({
        show,
        season,
        durationSeconds,
      })),
    ).toEqual([
      { show: 'First Show', season: 1, durationSeconds: 1800 },
      { show: 'Second Show', season: 2, durationSeconds: 1800 },
    ]);
    expect(Object.keys(result.viewings[0]!)).not.toContain('City');
  });

  it('collapses material-label changes for one raw identity', () => {
    const one = `"Deleted from Watch History","Most Recent Watch Date","Seconds Watched","Title Description","Title Name"
no,2026-01-01T12:00:00Z,1800,Shared title,Shared`;
    const conflicting = `"Material Type Description","Playback Start Datetime (UTC)","Seconds Viewed","Title"
Feature,2026-01-01T11:59:00Z,1800,Shared
Full,2026-01-01T11:58:00Z,1800,Shared`;
    const result = parsePrimeFiles([
      { name: 'events.csv', text: one },
      { name: 'history.csv', text: conflicting },
    ]);
    expect(result.viewings).toEqual([
      expect.objectContaining({ kind: 'movie', title: 'Shared', rawTitle: 'Shared' }),
    ]);
    expect(result.diagnostics.ambiguous).toEqual([]);
  });

  it('uses composite identity rather than unstable material labels to distinguish films and episodes', () => {
    const events = `"Deleted from Watch History","Most Recent Watch Date","Seconds Watched","Title Description","Title Name"
no,2020-01-01T12:00:00Z,1800,Old episode,Pilot
no,2026-01-02T12:00:00Z,6000,New film,Standalone`;
    const sessions = `"Material Type Description","Playback Start Datetime (UTC)","Seconds Viewed","Title"
Feature,2020-01-01T11:30:00Z,1800,Pilot-Old Show - Season 1
Full,2026-01-02T10:20:00Z,6000,Standalone`;
    const result = parsePrimeFiles([
      { name: 'events.csv', text: events },
      { name: 'history.csv', text: sessions },
    ]);
    expect(result.viewings).toEqual([
      expect.objectContaining({ kind: 'episode', show: 'Old Show', season: 1 }),
      expect.objectContaining({ kind: 'movie', title: 'Standalone' }),
    ]);
  });

  it('uses exact identity and watch seconds to resolve safe prefix collisions', () => {
    const events = `"Deleted from Watch History","Most Recent Watch Date","Seconds Watched","Title Description","Title Name"
no,2026-01-01T12:00:00Z,6000,Film,After
no,2026-01-02T12:00:00Z,1500,Season two,Episode 6`;
    const sessions = `"Material Type Description","Playback Start Datetime (UTC)","Seconds Viewed","Title"
Full,2026-01-01T11:00:00Z,5900,After
Full,2026-01-01T10:00:00Z,5700,After We Fell
Full,2026-01-02T11:30:00Z,1498,Episode 6-Show - Season 2
Full,2026-01-02T11:00:00Z,1100,Episode 6-Show - Season 1`;
    const result = parsePrimeFiles([
      { name: 'events.csv', text: events },
      { name: 'history.csv', text: sessions },
    ]);
    expect(result.diagnostics.ambiguous).toEqual([]);
    expect(result.viewings.map((viewing) => viewing.rawTitle)).toEqual([
      'After',
      'Episode 6-Show - Season 2',
    ]);
  });

  it('joins a composite episode title with one provider spelling difference', () => {
    const events = `"Deleted from Watch History","Most Recent Watch Date","Seconds Watched","Title Description","Title Name"
no,2026-01-01T12:00:00Z,25,Episode,Laura y Jan - Tiago y Mimi`;
    const sessions = `"Material Type Description","Playback Start Datetime (UTC)","Seconds Viewed","Title"
Full,2026-01-01T11:59:00Z,24,Laia-Jan/Tiago-Mimi-Citas Barcelona - Temporada 1`;
    const result = parsePrimeFiles([
      { name: 'events.csv', text: events },
      { name: 'history.csv', text: sessions },
    ]);
    expect(result.viewings[0]).toMatchObject({
      kind: 'episode',
      show: 'Citas Barcelona',
      season: 1,
    });
  });

  it('does not join a generic episode name to a matching row years away', () => {
    const events = `"Deleted from Watch History","Most Recent Watch Date","Seconds Watched","Title Description","Title Name"
no,2019-01-01T12:00:00Z,1300,Old pilot,Pilot`;
    const sessions = `"Material Type Description","Playback Start Datetime (UTC)","Seconds Viewed","Title"
Full,2023-01-01T11:30:00Z,1300,Pilot-New Show - Season 1`;
    const result = parsePrimeFiles([
      { name: 'events.csv', text: events },
      { name: 'history.csv', text: sessions },
    ]);
    expect(result.viewings).toEqual([]);
    expect(result.diagnostics.unmatched).toEqual(['Pilot']);
  });

  it('silently excludes trailers even when Amazon labels them as full content', () => {
    const events = `"Deleted from Watch History","Most Recent Watch Date","Seconds Watched","Title Description","Title Name"
no,2026-01-01T12:00:00Z,120,Preview,The Show - Official Trailer`;
    const sessions = `"Material Type Description","Playback Start Datetime (UTC)","Seconds Viewed","Title"
Full,2026-01-01T11:58:00Z,120,The Show - Official Trailer`;
    const result = parsePrimeFiles([
      { name: 'events.csv', text: events },
      { name: 'history.csv', text: sessions },
    ]);
    expect(result.viewings).toEqual([]);
    expect(result.diagnostics.unmatched).toEqual([]);
  });

  it('recognizes a trailer from Viewing History unless a full play of that title also exists', () => {
    const events = `"Deleted from Watch History","Most Recent Watch Date","Seconds Watched","Title Description","Title Name"
no,2026-01-01T12:00:00Z,76,Trailer shown as a film,Maria
no,2026-01-02T12:00:00Z,73,Partial film,Devil's Knot`;
    const sessions = `"Material Type Description","Playback Start Datetime (UTC)","Seconds Viewed","Title"
Trailer,2026-01-01T11:59:00Z,76,Maria
Trailer,2026-01-02T11:59:00Z,52,Devil's Knot
Full,2026-01-02T12:01:00Z,58,Devil's Knot`;
    const result = parsePrimeFiles([
      { name: 'events.csv', text: events },
      { name: 'history.csv', text: sessions },
    ]);
    expect(result.viewings.map((viewing) => viewing.title)).toEqual(["Devil's Knot"]);
    expect(result.diagnostics.unmatched).toEqual([]);
  });

  it('joins a translated named episode only with a uniquely corroborating duration', () => {
    const events = `"Deleted from Watch History","Most Recent Watch Date","Seconds Watched","Title Description","Title Name"
no,2026-01-01T12:00:00Z,1978,A Rings episode,Adar`;
    const sessions = `"Material Type Description","Playback Start Datetime (UTC)","Seconds Viewed","Title"
Full,2026-01-01T11:27:00Z,1960,Der Feind-The Rings Season 1`;
    const result = parsePrimeFiles([
      { name: 'events.csv', text: events },
      { name: 'history.csv', text: sessions },
    ]);
    expect(result.viewings[0]).toMatchObject({
      kind: 'episode',
      rawTitle: 'Der Feind-The Rings Season 1',
      show: 'The Rings',
      season: 1,
    });
  });

  it('keeps exact low-duration translated films and exposes only safe nearby series context', () => {
    const events = `"Deleted from Watch History","Most Recent Watch Date","Seconds Watched","Title Description","Title Name"
no,2026-01-01T12:00:00Z,14,A translated film,The Longest Week
no,2026-01-02T12:00:00Z,4000,Adar overview,Adar
no,2026-01-03T12:00:00Z,1900,Generic pilot overview,Pilot
no,2026-01-04T12:00:00Z,1800,Generic chapter overview,Capítulo 1`;
    const sessions = `"Material Type Description","Playback Start Datetime (UTC)","Seconds Viewed","Title"
Full,2026-01-01T11:59:00Z,14.5,La semana más larga
Full,2026-01-02T11:30:00Z,3900,Partings-The Rings - Season 1
Full,2026-01-03T11:30:00Z,1850,Second-The O.C. - Season 1
Full,2026-01-04T11:30:00Z,1800,Otro capítulo-La Serie - Temporada 1`;
    const result = parsePrimeFiles([
      { name: 'events.csv', text: events },
      { name: 'history.csv', text: sessions },
    ]);
    expect(result.viewings).toEqual([
      expect.objectContaining({
        kind: 'movie',
        title: 'The Longest Week',
        rawTitle: 'La semana más larga',
      }),
      expect.objectContaining({
        kind: 'episode',
        title: 'Adar',
        rawTitle: 'Adar',
        contextShows: expect.arrayContaining(['The Rings']),
      }),
    ]);
    expect(result.diagnostics.unmatched).toEqual(['Pilot', 'Capítulo 1']);
  });
});
