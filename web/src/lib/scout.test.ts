import { describe, expect, it } from 'vitest';
import { findScout, lanInstalls } from './scout';

const SCOUT = 'http://192.168.86.193:8080/sealed-cfg/manifest.json';
const SUBTITLES = 'http://192.168.86.193:8093/subs-cfg/manifest.json';
const PUBLIC = 'https://torrentio.example/debrid-token/manifest.json';

describe('findScout', () => {
  it('tries only LAN plugins against scout on this origin, and never sends a public addon its URL', async () => {
    const asked: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      asked.push(String(input));
      const id = String(input) === '/scout/sealed-cfg/manifest.json' ? 'com.den.scout' : 'com.den.subtitles';
      return new Response(JSON.stringify({ id }), { status: 200 });
    };
    expect(await findScout([PUBLIC, SUBTITLES, SCOUT], fetchImpl)).toEqual({
      install: 'http://192.168.86.193:8080/sealed-cfg',
      config: 'sealed-cfg',
    });
    expect(asked).toEqual(['/scout/subs-cfg/manifest.json', '/scout/sealed-cfg/manifest.json']);
  });

  it('is null when no plugin is scout', async () => {
    expect(await findScout([PUBLIC], async () => new Response('{}'))).toBeNull();
  });
});

describe('lanInstalls', () => {
  it('lists the other LAN addons, without their manifest file', () => {
    const scout = { install: 'http://192.168.86.193:8080/sealed-cfg', config: 'sealed-cfg' };
    expect(lanInstalls([PUBLIC, SUBTITLES, SCOUT], scout)).toEqual(['http://192.168.86.193:8093/subs-cfg']);
  });
});
