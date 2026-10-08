import { serialize } from 'node:v8';
import { describe, expect, it } from 'vitest';
import { activeHomeFixture, REPRESENTATIVE_HOME_FIXTURE } from './activeHomePayload.testFixture';
import { isDocument } from './wire';

describe('the active Home worker payload contract', () => {
  it('keeps mixed v4 episode history behind the compact view and finishes Continue from shapes', async () => {
    const fixture = await activeHomeFixture({ titles: 90, series: 18, downloads: 3 });
    const documents = fixture.source.filter(isDocument);

    expect(documents).toHaveLength(108);
    expect(documents.every((document) => document.format === 4)).toBe(true);
    expect(documents.filter((document) => document.kind === 'season')).toHaveLength(18);
    expect(fixture.rows).toHaveLength(115);
    expect(fixture.library.records).toHaveLength(90);
    expect(fixture.library.marks).toHaveLength(18 * 16);
    expect(fixture.library.flags).toHaveLength(18);

    expect(fixture.view.owned).toHaveLength(90);
    expect(fixture.view.requiredShapeRefs).toHaveLength(18);
    expect(fixture.view.continueLibrary.marks).toHaveLength(18 * 2);
    expect(fixture.view.continueLibrary.flags).toHaveLength(18);
    expect(fixture.view.downloads.map((download) => download.title.title)).toEqual([
      'Download 0',
      'Download 1',
      'Download 2',
    ]);
    expect(fixture.initial).toEqual([]);
    expect(fixture.payload.view).not.toHaveProperty('continueLibrary');
    expect(fixture.payload).not.toHaveProperty('library');
    expect(fixture.payload).not.toHaveProperty('rows');
    expect(fixture.exact).toEqual(fixture.fullExact);
    expect(fixture.exact).toHaveLength(18);
    expect(fixture.shapeRequest).toHaveLength(18);
  });

  it('projects only settings Home consumes before paint', async () => {
    const { payload } = await activeHomeFixture({ titles: 12, series: 3, downloads: 1 });

    expect(payload.settings).toEqual({
      tmdbKey: 'tmdb-home',
      plugins: [
        'http://plugins.example/insecure/manifest.json',
        'https://plugins.example/a/manifest.json',
        'https://plugins.example/z/manifest.json',
      ],
      remux: 'https://home.tail0000.ts.net',
      prefs: {
        excludedGenres: [27, 99],
        excludedLanguages: ['ja', 'ko'],
        hideAnime: true,
        hideWatched: true,
        minReleaseYear: 1995,
        services: [
          { id: 8, country: 'UY' },
          { id: 9, country: 'US' },
        ],
        servicesConfigured: true,
      },
    });
    expect(payload.settings).not.toHaveProperty('omdb');
    expect(payload.settings).not.toHaveProperty('watchRegion');
    expect(payload.settings).not.toHaveProperty('scout');
  });

  it('stays below the representative first-reply and Continue round-trip limits', async () => {
    const fixture = await activeHomeFixture(REPRESENTATIVE_HOME_FIXTURE);
    const currentBytes = serialize(fixture.currentReply).byteLength;
    const payloadBytes = serialize(fixture.payload).byteLength;
    const continueRoundTripBytes =
      serialize(fixture.shapeRequest).byteLength + serialize(fixture.exact).byteLength;

    expect(payloadBytes).toBeLessThan(currentBytes / 10);
    expect(payloadBytes).toBeLessThan(512 * 1024);
    expect(continueRoundTripBytes).toBeLessThan(256 * 1024);
  });
});
