// What the page hands the library service from the old localStorage clock (`den.deviceID`, `den.clock`).

export interface LegacyClockHello {
  device?: string;
  last?: [number, number, string];
}

/**
 * A clock that never ticked is stored as `[0, 0, ""]`; it carries no stamp, and the service seeds exactly that when
 * `last` is absent, so it is left out rather than sent as a stamp the wire codec rightly refuses.
 */
export function legacyClockBootstrap(
  storage: Pick<Storage, 'getItem'> = localStorage,
): LegacyClockHello | undefined {
  try {
    const device = storage.getItem('den.deviceID') ?? undefined;
    const parsed: unknown = JSON.parse(storage.getItem('den.clock') ?? 'null');
    const last =
      Array.isArray(parsed) &&
      parsed.length === 3 &&
      typeof parsed[0] === 'number' &&
      typeof parsed[1] === 'number' &&
      typeof parsed[2] === 'string' &&
      parsed[2] !== ''
        ? ([parsed[0], parsed[1], parsed[2]] as [number, number, string])
        : undefined;
    return device || last
      ? { ...(device ? { device } : {}), ...(last ? { last } : {}) }
      : undefined;
  } catch (error) {
    console.warn('den: the clock kept in this browser could not be read; starting a fresh one', error);
    return undefined;
  }
}
