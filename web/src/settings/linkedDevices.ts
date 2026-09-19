import type { Link, Shared } from '../lib/links.svelte';
import type { DeviceEntry } from './values';

/** One device as Settings presents it, with every independently actionable record kept on the row. */
export interface LinkedDeviceRow {
  /** Stable across refreshes; source prefixes prevent unrelated identifiers from colliding. */
  id: string;
  name: string;
  kind: 'tv' | 'browser';
  device?: DeviceEntry;
  links: Link[];
  shared: Shared[];
}

const identityName = (name: string | undefined): string => name?.trim().toLowerCase() ?? '';

/**
 * Combines the current library's self-reported devices with records kept by this browser. New pairing records
 * match only by the stable stamp device id exchanged by pairing. A conservative name/time fallback remains for
 * records created before either wire field existed and never guesses between duplicate names.
 */
export function linkedDeviceRows(
  devices: readonly DeviceEntry[],
  links: readonly Link[],
  shared: readonly Shared[],
  currentLibraryKey?: string,
): LinkedDeviceRow[] {
  const rows = devices.map((device): LinkedDeviceRow => ({
    id: `device:${device.id}`,
    name: device.name,
    kind: device.kind,
    device,
    links: [],
    shared: [],
  }));
  const deviceByID = new Map(devices.map((device) => [device.id, device]));

  const legacyLink = (link: Link): DeviceEntry | undefined => {
    const name = identityName(link.name);
    if (!name) return undefined;
    const candidates = devices.filter((device) => identityName(device.name) === name);
    const records = links.filter(
      (candidate) =>
        !candidate.deviceId &&
        candidate.libraryKey === currentLibraryKey &&
        identityName(candidate.name) === name,
    );
    const handoffs = shared.filter(
      (candidate) =>
        !candidate.deviceId &&
        !candidate.inboxKey &&
        candidate.libraryKey === currentLibraryKey &&
        identityName(candidate.name) === name,
    );
    return candidates.length === 1 && records.length === 1 && handoffs.length === 0
      ? candidates[0]
      : undefined;
  };

  const deviceForLink = (link: Link): DeviceEntry | undefined => {
    if (!currentLibraryKey || link.libraryKey !== currentLibraryKey) return undefined;
    return link.deviceId ? deviceByID.get(link.deviceId) : legacyLink(link);
  };

  const legacyShare = (entry: Shared): DeviceEntry | undefined => {
    // A current pairing with a pending identity has credentials; don't turn its editable label into identity.
    if (entry.inboxKey || entry.linkKey) return undefined;
    const name = identityName(entry.name);
    const candidates = devices.filter((device) => identityName(device.name) === name);
    const belongsHere =
      entry.libraryKey === currentLibraryKey ||
      (!entry.libraryKey &&
        candidates.length === 1 &&
        candidates[0]?.seen !== undefined &&
        candidates[0].seen >= entry.at);
    if (!name || !belongsHere) return undefined;
    const records = shared.filter((candidate) => {
      if (candidate.deviceId || candidate.inboxKey || identityName(candidate.name) !== name)
        return false;
      if (candidate.libraryKey) return candidate.libraryKey === currentLibraryKey;
      return (
        candidates.length === 1 &&
        candidates[0]?.seen !== undefined &&
        candidates[0].seen >= candidate.at
      );
    });
    const paired = links.filter(
      (candidate) =>
        !candidate.deviceId &&
        candidate.libraryKey === currentLibraryKey &&
        identityName(candidate.name) === name,
    );
    return candidates.length === 1 && records.length === 1 && paired.length === 0
      ? candidates[0]
      : undefined;
  };

  const deviceForShare = (entry: Shared): DeviceEntry | undefined => {
    if (!currentLibraryKey) return undefined;
    if (entry.deviceId)
      return entry.libraryKey === currentLibraryKey ? deviceByID.get(entry.deviceId) : undefined;
    return legacyShare(entry);
  };

  for (const link of links) {
    const device = deviceForLink(link);
    const row = device ? rows.find((candidate) => candidate.device === device) : undefined;
    if (row) row.links.push(link);
    else
      rows.push({
        id: `link:${link.inboxKey}`,
        name: link.name ?? 'Apple TV',
        kind: 'tv',
        links: [link],
        shared: [],
      });
  }

  for (const entry of shared) {
    const device = deviceForShare(entry);
    const row = device ? rows.find((candidate) => candidate.device === device) : undefined;
    if (row) row.shared.push(entry);
    else
      rows.push({
        id: `shared:${entry.deviceId ?? entry.inboxKey ?? `${entry.at}:${identityName(entry.name)}`}`,
        name: entry.name,
        kind: /Apple TV/i.test(entry.name) ? 'tv' : 'browser',
        links: [],
        shared: [entry],
      });
  }

  return rows;
}
