import { describe, expect, it } from 'vitest';
import { parsePlayerAddress, withPlayerAddress } from './playerAddress';

const PAGE = '/tv/90282-the-morning-show?season=2&episode=1&play=1';

describe('player address', () => {
  it('round-trips every choice behind the route’s own params', () => {
    const path = withPlayerAddress(PAGE, {
      source: 'The.Morning.Show.S02E01.2160p.ATVP.WEB-DL.mkv',
      via: 'remux',
      audio: 1,
      subtitles: { language: 'sv', track: 'remux:built-in:0:sv' },
      subtitleDelay: -1.5,
      at: 1312.8,
    });
    expect(path).toBe(
      '/tv/90282-the-morning-show?season=2&episode=1&play=1' +
        '&source=The.Morning.Show.S02E01.2160p.ATVP.WEB-DL.mkv&via=remux&audio=1&subs=sv' +
        '&subtrack=remux%3Abuilt-in%3A0%3Asv&subdelay=-1.5&t=1312',
    );
    expect(parsePlayerAddress(new URL(path, 'https://x.test').search)).toEqual({
      source: 'The.Morning.Show.S02E01.2160p.ATVP.WEB-DL.mkv',
      via: 'remux',
      audio: 1,
      subtitles: { language: 'sv', track: 'remux:built-in:0:sv' },
      subtitleDelay: -1.5,
      at: 1312,
    });
  });

  it('replaces what it wrote before and drops what is no longer chosen', () => {
    const before = `${PAGE}&source=a.mkv&audio=2&subs=off&t=90`;
    expect(withPlayerAddress(before, { subtitles: 'off' })).toBe(`${PAGE}&subs=off`);
    expect(withPlayerAddress(before, {})).toBe(PAGE);
  });

  it('never writes a URL, ticket or token, whatever it is handed', () => {
    for (const source of [
      'https://cdn.example/master.m3u8',
      '/scout/p/abcdef',
      'file.mkv?sig=abc',
      'x#y',
      'release token=abc',
    ])
      expect(withPlayerAddress(PAGE, { source })).toBe(PAGE);
    expect(
      withPlayerAddress(PAGE, {
        subtitles: { language: 'en', track: 'https://subs.example/x.vtt?token=1' },
      }),
    ).toBe(`${PAGE}&subs=en`);
  });

  it('reads back only values it could have written', () => {
    expect(
      parsePlayerAddress(
        '?source=https%3A%2F%2Fx%2Fm3u8&via=cdn&audio=-1&subs=<b>&subtrack=a&subdelay=31&t=abc',
      ),
    ).toEqual({});
    expect(parsePlayerAddress('?audio=007&subdelay=1.25&t=0')).toEqual({});
    expect(parsePlayerAddress('?subs=pt-BR&subtrack=os%3A123&subdelay=2&t=5')).toEqual({
      subtitles: { language: 'pt-BR', track: 'os:123' },
      subtitleDelay: 2,
      at: 5,
    });
  });
});
