import { describe, expect, it } from 'vitest';
import { ahead, healed, readPrivateAddresses, storable } from './privateAddresses';
import type { SettingsRow, Stamp } from './wire';

const TAILNET = 'https://pve.tailce93d3.ts.net:8443/remux';
const at: Stamp = [1, 1, 'd'];

const row = (values: Record<string, string>): SettingsRow => ({
  kind: 'set',
  schema: 2,
  name: 'addresses',
  values: Object.fromEntries(
    Object.entries(values).map(([service, url]) => [service, { value: { string: url }, at }]),
  ),
});

describe('storable', () => {
  it('takes a tailnet https base and nothing else', () => {
    expect(storable(TAILNET)).toBe(true);
    expect(storable('https://pve.tailce93d3.ts.net:8443')).toBe(true);
  });

  it('refuses what a page cannot use, or should not keep', () => {
    // Mixed content on an https page: refused by the browser before it is ever reached.
    expect(storable('http://pve.tailce93d3.ts.net:8443/remux')).toBe(false);
    // Not the tailnet. A LAN address means nothing to a browser that is not on that LAN, and a
    // public name is already the table's to give.
    expect(storable('https://192.168.86.193:8095/remux')).toBe(false);
    expect(storable('https://d-remux.oxy.fi/remux')).toBe(false);
    // A base to append paths to — not a URL carrying state of its own.
    expect(storable('https://pve.tailce93d3.ts.net/remux?token=secret')).toBe(false);
    expect(storable('https://pve.tailce93d3.ts.net/remux#x')).toBe(false);
    // A credential in a URL is a credential written into the library and into every log it reaches.
    expect(storable('https://user:pw@pve.tailce93d3.ts.net/remux')).toBe(false);
    // And a hostname that merely ends in the same letters is not the tailnet.
    expect(storable('https://evil.example.ts.net.attacker.example/remux')).toBe(false);
    expect(storable('not a url')).toBe(false);
  });
});

describe('readPrivateAddresses', () => {
  it('reads the addresses a household stored, without their trailing slash', () => {
    expect(readPrivateAddresses(row({ remux: `${TAILNET}/` }))).toEqual({ remux: TAILNET });
    expect(readPrivateAddresses(undefined), 'a guest holds no library').toEqual({});
  });

  it('drops anything it would not have stored itself', () => {
    // Written by a client that believed something else, or by a future version: not ours to trust.
    expect(readPrivateAddresses(row({ remux: 'http://192.168.86.193:8095/remux' }))).toEqual({});
    expect(readPrivateAddresses(row({ 'Not A Service': TAILNET }))).toEqual({});
  });
});

describe('healed', () => {
  it('writes the address a device actually reached when the library disagrees', () => {
    expect(healed({}, 'remux', TAILNET)).toEqual({ remux: { string: TAILNET } });
    const renamed = 'https://pve.tailnew.ts.net:8443/remux';
    expect(healed({ remux: TAILNET }, 'remux', renamed)).toEqual({ remux: { string: renamed } });
  });

  it('writes nothing when the library already says it', () => {
    expect(healed({ remux: TAILNET }, 'remux', TAILNET)).toBeNull();
    expect(healed({ remux: TAILNET }, 'remux', `${TAILNET}/`)).toBeNull();
  });

  /**
   * A probe fails for the ordinary reason that the viewer is off the tailnet, which is exactly when
   * the address cannot be verified — forgetting it then erases the household's only copy.
   */
  it('never clears, and never stores an address it would not have kept', () => {
    expect(healed({ remux: TAILNET }, 'remux', null)).toBeNull();
    expect(healed({}, 'remux', 'http://192.168.86.193:8095/remux')).toBeNull();
  });
});

describe('ahead', () => {
  const table = [{ url: 'http://192.168.86.193:8095/remux' }, { url: TAILNET }];

  it('puts the stored address first and never probes one twice', () => {
    expect(ahead(TAILNET, table)).toEqual([{ url: TAILNET }, table[0]]);
    expect(ahead(undefined, table)).toEqual(table);
    // On the public name the table names no remux at all, and the stored address is all there is.
    expect(ahead(TAILNET, [])).toEqual([{ url: TAILNET }]);
    expect(ahead(undefined, [])).toEqual([]);
  });
});
