import { describe, expect, it } from 'vitest';
import type { Release, Session } from './remux';
import {
  nothingFits,
  optionLabel,
  releaseAfterMeasure,
  restartAfterMeasure,
  swapNotice,
  unchangedNotice,
  unplayable,
} from './releaseVerdicts';

describe('releaseAfterMeasure', () => {
  it('names nothing when den-remux picked, so it picks again under the measured link', () => {
    expect(releaseAfterMeasure(undefined)).toBeUndefined();
  });
  it("keeps the viewer's own choice, however big", () => {
    expect(releaseAfterMeasure('4k.mkv')).toEqual({ filename: '4k.mkv' });
  });
});

describe('restartAfterMeasure', () => {
  // The guest's 1080p WEB-DL: 2.88 GB over two hours averages 3.2 Mbit/s.
  const web = {
    duration: 7_200,
    release: { label: '1080p', filename: 'web.mkv', size: 2_880_000_000 },
  };

  it('keeps a copy that fits the link, and starts again for one that needs more', () => {
    expect(restartAfterMeasure(web, 3_780_000), '70% of a 5.4 Mbit/s link').toBe(false);
    expect(restartAfterMeasure(web, 3_200_000), 'exactly its average fits').toBe(false);
    expect(restartAfterMeasure(web, 3_199_999)).toBe(true);
  });

  it('starts a conversion again only where the link won’t take its 1080p preset', () => {
    const converted = { ...web, video: { codec: 'h264', transcoded: true } };
    expect(restartAfterMeasure(converted, 3_780_000)).toBe(true);
    expect(restartAfterMeasure(converted, 8_384_000)).toBe(false);
  });

  it('starts again, as before, when the session doesn’t say enough to judge', () => {
    expect(restartAfterMeasure({ ...web, duration: 0 }, 100_000_000)).toBe(true);
    expect(restartAfterMeasure({ ...web, release: { ...web.release, size: 0 } }, 1e9)).toBe(true);
  });
});

const session = (release: Partial<Session['release']> = {}): Session => ({
  playlist: '/remux/s/sid/sig/master.m3u8',
  duration: 7200,
  release: { label: '1080p • WEB-DL', filename: 'b.mkv', size: 1, ...release },
  audioTrack: 0,
  audioTracks: [],
});

describe('swapNotice', () => {
  it('says nothing when the release asked for is the one playing, or none was asked for', () => {
    expect(swapNotice('b.mkv', session())).toBeNull();
    expect(swapNotice(undefined, session())).toBeNull();
  });

  it('says only that it couldn’t play here when den-remux gives no reason', () => {
    expect(swapNotice('a.mkv', session(), () => '4K • REMUX')).toBe(
      'Couldn’t play 4K • REMUX in this browser — playing 1080p • WEB-DL instead.',
    );
  });

  it('gives den-remux’s reason, and its account of what was asked for over the page’s', () => {
    const swapped = session({ requested: { filename: 'a.mkv', why: 'Dolby Vision profile 5' } });
    expect(swapNotice(undefined, swapped)).toBe(
      'Couldn’t play a.mkv here (Dolby Vision profile 5) — playing 1080p • WEB-DL instead.',
    );
    expect(swapNotice('x.mkv', swapped, (f) => `label of ${f}`)).toContain('label of a.mkv');
  });

  it('is silent when den-remux names the very release that plays as the requested one', () => {
    expect(swapNotice('b.mkv', session({ requested: { filename: 'b.mkv' } }))).toBeNull();
  });
});

describe('unplayable', () => {
  const list: Release[] = [
    { label: 'a', filename: 'a.mkv', plays: 'no', why: 'no HDR here' },
    { label: 'b', filename: 'b.mkv', plays: 'convert' },
    { label: 'c', filename: 'c.mkv', plays: 'no' },
    { label: 'd', filename: 'd.mkv', plays: 'yes' },
  ];

  it('holds the releases that won’t play, with their reasons', () => {
    expect([...unplayable(list)]).toEqual([
      ['a.mkv', 'no HDR here'],
      ['c.mkv', ''],
    ]);
  });

  it('fails open: no verdicts disable nothing', () => {
    expect(unplayable(null).size).toBe(0);
    expect(unplayable(undefined).size).toBe(0);
    expect(unplayable([]).size).toBe(0);
  });
});

describe('optionLabel', () => {
  it('marks what won’t play, and what is converted, and leaves the rest alone', () => {
    expect(optionLabel({ label: 'a', filename: 'a', plays: 'no' })).toBe('a — can’t play here');
    expect(optionLabel({ label: 'a', filename: 'a', plays: 'convert' })).toBe('a — converted');
    expect(optionLabel({ label: 'a', filename: 'a', plays: 'yes' })).toBe('a');
  });
});

describe('unchangedNotice', () => {
  it('says a change could not be made as a copy only when no copy would do', () => {
    for (const failure of ['none', 'noCopy', 'noFit', 'transcode'] as const) {
      expect(nothingFits(failure)).toBe(true);
      expect(unchangedNotice(failure)).toBe(
        'That can’t be played here as it is, so this carries on as it was.',
      );
    }
  });

  it('gives den-remux’s own reason for any other refusal', () => {
    for (const failure of [
      'unreachable',
      'busy',
      'login',
      'ended',
      'public',
      'ipv6',
      'cast',
    ] as const)
      expect(nothingFits(failure), failure).toBe(false);
    expect(unchangedNotice('unreachable')).toContain('Couldn’t reach Den’s player');
    expect(unchangedNotice('busy')).toContain('already playing two things');
    expect(unchangedNotice('login')).toContain('key');
    expect(unchangedNotice('ended', 'Your access to Kim’s library ended')).toBe(
      'Your access to Kim’s library ended, so this carries on as it was.',
    );
  });
});
