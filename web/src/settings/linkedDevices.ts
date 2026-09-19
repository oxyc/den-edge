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

const identityName = (name: string | undefined): string => name?.trim().toLocaleLowerCase() ?? '';

/**
 * Combines the current library's self-reported devices with records kept by this browser.
 *
 * Pairing v1 does not exchange the stamp device id, so a name by itself is not an identity. A local record is
 * attached to a library device only when both sides name exactly one candidate and the record can be tied to this
 * library. Ambiguous names and records for another library deliberately remain separate rows.
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

  const attachableLink = (link: Link): DeviceEntry | undefined => {
    if (!currentLibraryKey || link.libraryKey !== currentLibraryKey) return undefined;
    const name = identityName(link.name);
    if (!name) return undefined;
    const candidates = devices.filter(
      (device) => device.kind === 'tv' && identityName(device.name) === name,
    );
    const records = links.filter(
      (candidate) =>
        candidate.libraryKey === currentLibraryKey && identityName(candidate.name) === name,
    );
    const handoffs = shared.filter((candidate) => {
      if (identityName(candidate.name) !== name) return false;
      if (candidate.libraryKey) return candidate.libraryKey === currentLibraryKey;
      return (
        candidates.length === 1 &&
        candidates[0]?.seen !== undefined &&
        candidates[0].seen >= candidate.at
      );
    });
    return candidates.length === 1 && records.length === 1 && handoffs.length === 0
      ? candidates[0]
      : undefined;
  };

  const attachableShare = (entry: Shared): DeviceEntry | undefined => {
    const name = identityName(entry.name);
    const candidates = devices.filter((device) => identityName(device.name) === name);
    const belongsHere =
      entry.libraryKey === currentLibraryKey ||
      (!entry.libraryKey &&
        candidates.length === 1 &&
        candidates[0]?.seen !== undefined &&
        candidates[0].seen >= entry.at);
    if (!name || !currentLibraryKey || !belongsHere) return undefined;
    const records = shared.filter((candidate) => {
      if (identityName(candidate.name) !== name) return false;
      if (candidate.libraryKey) return candidate.libraryKey === currentLibraryKey;
      return (
        candidates.length === 1 &&
        candidates[0]?.seen !== undefined &&
        candidates[0].seen >= candidate.at
      );
    });
    const paired = links.filter(
      (candidate) =>
        candidate.libraryKey === currentLibraryKey && identityName(candidate.name) === name,
    );
    return candidates.length === 1 && records.length === 1 && paired.length === 0
      ? candidates[0]
      : undefined;
  };

  for (const link of links) {
    const device = attachableLink(link);
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

  shared.forEach((entry) => {
    const device = attachableShare(entry);
    const row = device ? rows.find((candidate) => candidate.device === device) : undefined;
    if (row) row.shared.push(entry);
    else
      rows.push({
        id: `shared:${entry.id ?? `${entry.at}:${identityName(entry.name)}`}`,
        name: entry.name,
        kind: /Apple TV/i.test(entry.name) ? 'tv' : 'browser',
        links: [],
        shared: [entry],
      });
  });

  return rows;
}
