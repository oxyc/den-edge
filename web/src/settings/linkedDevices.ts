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
