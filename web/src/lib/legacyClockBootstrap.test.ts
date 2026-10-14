import { describe, expect, it } from 'vitest';
import { legacyClockBootstrap } from './legacyClockBootstrap';
import { decodeLibraryServiceClientMessage } from './libraryServiceProtocolCodec';
import { LIBRARY_SERVICE_PROTOCOL } from './libraryServiceProtocol';

const storage = (items: Record<string, string>) => ({
  getItem: (key: string) => items[key] ?? null,
});

describe('legacyClockBootstrap', () => {
  it('omits a clock that never ticked, so the hello stays valid', () => {
    const device = '0123456789abcdef';
    const clock = legacyClockBootstrap(
      storage({ 'den.deviceID': device, 'den.clock': '[0,0,""]' }),
    );
    expect(clock).toEqual({ device });
    expect(legacyClockBootstrap(storage({ 'den.clock': '[0,0,""]' }))).toBeUndefined();
  });

  it('keeps a stamp that was issued', () => {
    const clock = legacyClockBootstrap(
      storage({ 'den.deviceID': '0123456789abcdef', 'den.clock': '[10,2,"0123456789abcdef"]' }),
    );
    expect(clock?.last).toEqual([10, 2, '0123456789abcdef']);
  });

  it('is absent without storage entries or on malformed JSON', () => {
    expect(legacyClockBootstrap(storage({}))).toBeUndefined();
    expect(legacyClockBootstrap(storage({ 'den.clock': '{' }))).toBeUndefined();
  });

  it('builds a hello the wire codec accepts from a never-ticked clock', () => {
    const legacyClock = legacyClockBootstrap(
      storage({ 'den.deviceID': '0123456789abcdef', 'den.clock': '[0,0,""]' }),
    );
    expect(
      decodeLibraryServiceClientMessage({
        type: 'hello',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        requestId: 'request-1',
        clientId: 'tab-1',
        libraryKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        wire: 4,
        mode: 'local',
        ...(legacyClock ? { legacyClock } : {}),
      }),
    ).toMatchObject({ ok: true, value: { type: 'hello' } });
  });
});
