import { beforeAll, describe, expect, it } from 'vitest';
import { initialize } from '../vendor/den-core/index.js';
import { librarySwitchState } from './librarySwitch';
import type { DeviceEntry } from '../settings/values';

const device = (overrides: Partial<DeviceEntry> = {}): DeviceEntry => ({
  id: 'web',
  name: 'Browser',
  kind: 'browser',
  seen: 1000,
  pending: [],
  format: 3,
  facade: [],
  delivers: [],
  waiting: {},
  connectedAt: {},
  handoff: {},
  ...overrides,
});

beforeAll(() => initialize());

describe('Library v3 switch offer', () => {
  it('allows the web-only path when every listed device is ready', () => {
    expect(librarySwitchState([device()], 'web', 1000)).toEqual({
      offered: true,
      performable: true,
      blockers: [],
      webOnly: true,
    });
  });

  it('names an old device that keeps the switch from being offered', () => {
    const devices = [device(), device({ id: 'tv', name: 'Living room', kind: 'tv', format: 2 })];
    const state = librarySwitchState(devices, 'web', 1000);
    expect(state.offered).toBe(false);
    expect(state.blockers[0]).toMatchObject({ device: 'tv', reason: 'format' });
  });

  it('waits for a delivering TV to store its handoff', () => {
    const state = librarySwitchState(
      [device(), device({ id: 'tv', kind: 'tv', facade: ['simkl'], delivers: ['simkl:42'] })],
      'web',
      1000,
    );
    expect(state).toMatchObject({ offered: true, performable: false, webOnly: false });
    expect(state.blockers.map((blocker) => blocker.reason)).toContain('handoff');
  });

  it('accepts only a handoff for the account the device delivers', () => {
    const handedOff = device({
      id: 'tv',
      kind: 'tv',
      facade: ['simkl'],
      delivers: ['simkl:42'],
      handoff: { simkl: JSON.stringify({ account: '42' }) },
    });
    const mismatch = { ...handedOff, handoff: { simkl: JSON.stringify({ account: '7' }) } };
    expect(librarySwitchState([device(), handedOff], 'web', 1000).blockers).not.toContainEqual(
      expect.objectContaining({ reason: 'handoff' }),
    );
    expect(librarySwitchState([device(), mismatch], 'web', 1000).blockers).toContainEqual(
      expect.objectContaining({ reason: 'handoff' }),
    );
  });

  it('does not call a library web-only while another device has a delivery facade', () => {
    const state = librarySwitchState(
      [device(), device({ id: 'tv', kind: 'tv', facade: ['simkl'] })],
      'web',
      1000,
    );
    expect(state).toMatchObject({ performable: false, webOnly: false });
    expect(state.blockers).toContainEqual(expect.objectContaining({ reason: 'facade' }));
  });
});
