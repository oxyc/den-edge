import { describe, expect, it } from 'vitest';
import type { Release, Session } from './remux';
import { optionLabel, releaseAfterMeasure, swapNotice, unplayable } from './releaseVerdicts';

describe('releaseAfterMeasure', () => {
  it('names nothing when den-remux picked, so it picks again under the measured link', () => {
    expect(releaseAfterMeasure(undefined)).toBeUndefined();
  });
  it("keeps the viewer's own choice, however big", () => {
    expect(releaseAfterMeasure('4k.mkv')).toEqual({ filename: '4k.mkv' });
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
