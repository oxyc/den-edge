import { describe, expect, it } from 'vitest';
import { linkParts, mergeCredits, readAttribution } from './credits';

describe('credits from addon manifests', () => {
  it('reads each statement, keeping a link only when it is https', () => {
    expect(
      readAttribution({
        denAttribution: [
          {
            text: 'Subtitles from OpenSubtitles.com.',
            link: 'OpenSubtitles.com',
            url: 'https://www.opensubtitles.com',
          },
          { text: 'Plain http.', link: 'http', url: 'http://example.com' },
          { text: 'Script.', url: 'javascript:alert(1)' },
          { text: '' },
          { link: 'no text' },
          'not an object',
        ],
      }),
    ).toEqual([
      {
        text: 'Subtitles from OpenSubtitles.com.',
        link: 'OpenSubtitles.com',
        url: 'https://www.opensubtitles.com',
      },
      { text: 'Plain http.' },
      { text: 'Script.' },
    ]);
    expect(readAttribution({ id: 'com.den.scout' })).toEqual([]);
    expect(readAttribution(null)).toEqual([]);
  });

  it('splits a statement around its link, and links the whole of one whose link text is missing', () => {
    expect(
      linkParts({
        text: 'Streaming availability by JustWatch.',
        link: 'JustWatch',
        url: 'https://www.justwatch.com',
      }),
    ).toEqual({
      before: 'Streaming availability by ',
      link: 'JustWatch',
      after: '.',
    });
    expect(linkParts({ text: 'Data from X.', link: 'Y', url: 'https://x.example' })).toEqual({
      before: '',
      link: 'Data from X.',
      after: '',
    });
    expect(linkParts({ text: 'No link.' })).toBeNull();
  });

  it('shows a statement two addons share once, in their order', () => {
    const justWatch = { text: 'Streaming availability by JustWatch.' };
    expect(
      mergeCredits([
        [justWatch, { text: 'A.' }],
        [{ text: 'B.' }, justWatch],
      ]),
    ).toEqual([justWatch, { text: 'A.' }, { text: 'B.' }]);
  });
});
