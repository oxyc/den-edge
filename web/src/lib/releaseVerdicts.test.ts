import { describe, expect, it } from 'vitest';
import type { Release, Session } from './remux';
import {
  autoSwitchedNotice,
  autoSwitchNotice,
  deliveryUnchangedNotice,
  nothingFits,
  optionLabel,
  pickLabel,
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

describe('autoSwitchNotice', () => {
  it('names why, and counts in once the release list has loaded enough to', () => {
    expect(autoSwitchNotice('decode', '1080p • WEB-DL', 2, 5)).toBe(
      '1080p • WEB-DL couldn’t play here — trying another release… (2 of 5)',
    );
    expect(autoSwitchNotice('delivery', '4K • REMUX', 1)).toBe(
      '4K • REMUX is too slow for this connection — trying another release…',
    );
  });
});

describe('autoSwitchedNotice', () => {
  it('says what moved and why, past tense once it has landed', () => {
    expect(autoSwitchedNotice('decode', '1080p • WEB-DL', '720p • WEB')).toBe(
      '1080p • WEB-DL couldn’t play here — playing 720p • WEB instead.',
    );
    expect(autoSwitchedNotice('delivery', '4K • REMUX', '1080p • WEB-DL')).toBe(
      '4K • REMUX was too slow for this connection — playing 1080p • WEB-DL instead.',
    );
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
  it('reads scout’s bullets as the Sources panel does, the pack it came from included', () => {
    expect(
      optionLabel({
        label: '4K • WEB-DL • Dolby Vision • Atmos • 11 GB · from a 105 GB pack',
        filename: 'a',
        plays: 'yes',
      }),
    ).toBe('4K · WEB-DL · Dolby Vision · Atmos · 11 GB · from a 105 GB pack');
  });
});

describe('pickLabel', () => {
  it('is the quality and the size, without the pack', () => {
    expect(pickLabel({ label: '4K • WEB-DL • Dolby Vision • 11 GB · from a 105 GB pack' })).toBe(
      '4K · 11 GB',
    );
    expect(pickLabel({ label: '1080p • WEB-DL • 13.2 GB' })).toBe('1080p · 13.2 GB');
  });
  it('is the quality alone where no size is named', () => {
    expect(pickLabel({ label: '720p • WEB' })).toBe('720p');
    expect(pickLabel({ label: 'Fixture 1080p' })).toBe('Fixture 1080p');
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
      'starting',
      'login',
      'ended',
      'public',
      'ipv6',
      'cast',
      'request',
      'sourceUnavailable',
      'timedOut',
      'temporarilyUnavailable',
      'protocol',
    ] as const)
      expect(nothingFits(failure), failure).toBe(false);
    expect(unchangedNotice('unreachable')).toContain('Couldn’t reach Den’s player');
    expect(unchangedNotice('busy')).toContain('already playing as much as it can');
    // Distinct from `busy`: nothing of anyone else's is holding the slot, only this browser's or
    // install's own last attempt still opening.
    expect(unchangedNotice('starting')).toContain('finishing this browser');
    expect(unchangedNotice('login')).toContain('key');
    expect(unchangedNotice('request')).toContain('couldn’t use that request');
    expect(unchangedNotice('sourceUnavailable')).toContain('available playback paths');
    expect(unchangedNotice('timedOut')).toContain('took too long');
    expect(unchangedNotice('temporarilyUnavailable')).toContain('temporarily unavailable');
    expect(unchangedNotice('protocol')).toContain('answer this page couldn’t use');
    expect(unchangedNotice('ended', 'Your access to Kim’s library ended')).toBe(
      'Your access to Kim’s library ended, so this carries on as it was.',
    );
  });
});

describe('deliveryUnchangedNotice', () => {
  it('names the path that refused and the one that carries on', () => {
    expect(deliveryUnchangedNotice('TorBox', 'request')).toBe(
      'TorBox couldn’t play this release just now, so it carries on from Den Remux.',
    );
    expect(deliveryUnchangedNotice('Den Remux', 'transcode')).toBe(
      'Den Remux couldn’t play this release just now, so it carries on from TorBox.',
    );
  });

  it('says ended access as itself', () => {
    expect(deliveryUnchangedNotice('TorBox', 'ended', 'Your access to Kim’s library ended')).toBe(
      'Your access to Kim’s library ended, so this carries on as it was.',
    );
  });
});
