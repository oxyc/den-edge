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
 * match only by the stable stamp device id exchanged by pairing. Legacy records remain separate because an editable
 * label is never identity; associating one exactly requires pairing again.
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

  const deviceForLink = (link: Link): DeviceEntry | undefined => {
    if (!currentLibraryKey || link.libraryKey !== currentLibraryKey) return undefined;
    return link.deviceId ? deviceByID.get(link.deviceId) : undefined;
  };

  const deviceForShare = (entry: Shared): DeviceEntry | undefined => {
    if (!currentLibraryKey || entry.libraryKey !== currentLibraryKey || !entry.deviceId)
      return undefined;
    return deviceByID.get(entry.deviceId);
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

  for (const [index, entry] of shared.entries()) {
    const device = deviceForShare(entry);
    const row = device ? rows.find((candidate) => candidate.device === device) : undefined;
    if (row) row.shared.push(entry);
    else
      rows.push({
        id: `shared:${entry.inboxKey ?? `${entry.libraryKey ?? 'legacy'}:${entry.deviceId ?? `${entry.at}:${identityName(entry.name)}:${index}`}`}`,
        name: entry.name,
        kind: /Apple TV/i.test(entry.name) ? 'tv' : 'browser',
        links: [],
        shared: [entry],
      });
  }

  return rows;
}

/**
 * A row's second line: what the device is and when it last opened the library, or, for a device this browser gave a
 * library to that hasn't listed itself yet, when that was.
 */
export function deviceStatus(
  row: LinkedDeviceRow,
  selfId: string,
  currentLibraryKey: string | undefined,
  day: (at: number) => string,
): string {
  if (row.device) {
    const what =
      row.device.id === selfId ? 'This browser' : row.device.kind === 'tv' ? 'Apple TV' : 'Browser';
    return row.device.seen ? `${what} · seen ${day(row.device.seen)}` : what;
  }
  return row.shared
    .map((entry) =>
      entry.libraryKey && entry.libraryKey !== currentLibraryKey
        ? `added to another library ${day(entry.at)}`
        : `added ${day(entry.at)}`,
    )
    .join(' · ');
}

/** A saved library's name. Libraries carry no name of their own, so it's said by whether it's the one open here. */
export const libraryName = (linked: Link, currentLibraryKey: string | undefined): string =>
  linked.libraryKey === currentLibraryKey ? 'Your library' : 'Another library';

/** Rows that represent devices known to the shared library, not this browser's local credentials for opening one. */
export function syncedDeviceRows(
  devices: readonly DeviceEntry[],
  links: readonly Link[],
  shared: readonly Shared[],
  currentLibraryKey?: string,
): LinkedDeviceRow[] {
  return linkedDeviceRows(devices, links, shared, currentLibraryKey).filter(
    (row) => row.device !== undefined || row.shared.length > 0,
  );
}
