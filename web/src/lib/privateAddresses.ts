// The household's own addresses, carried in the library instead of in den-edge's table.
//
// On its public name den-edge serves a table naming only what a stranger may be told: no LAN address,
// no tailnet name. Someone on Tailscale is not a stranger, but the page they open on d.oxy.fi is
// served the stranger's table all the same, so den-remux appears in it nowhere and playback has
// nothing to reach — even though the machine is a hostname away.
//
// What the deployment will not publish, the household can carry for itself. The library is sealed:
// an address stored here is readable by the household's own devices and by nobody else, den-edge
// included. So this is not a second routes table. It holds only addresses a device has actually
// reached, for services the public table cannot name.

import type { Entry } from './routes';
import type { ConfigValue, SettingsRow } from './wire';

/** The settings group these live in (`set:addresses`). */
export const ADDRESSES = 'addresses';

/** Without its trailing slash, which would make `${url}/health` ask for `//health`. */
const trimmed = (url: string): string => url.replace(/\/+$/, '');

/**
 * An address worth keeping: a tailnet https base, and nothing else.
 *
 * https, because the page is, and a plain-http address is refused as mixed content before it is ever
 * reached. A `.ts.net` host, because the tailnet is the one private address that means anything to a
 * browser that is not on the LAN — and because a name nobody outside the tailnet can even resolve is
 * safe to keep in a way a public hostname would not be worth the storage for.
 *
 * No query, fragment or credentials: this is a base for paths to be appended to, and a credential in
 * a URL is a credential written into the library and then into every request log it reaches.
 */
export function storable(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname.toLowerCase().endsWith('.ts.net') &&
      parsed.search === '' &&
      parsed.hash === '' &&
      parsed.username === '' &&
      parsed.password === ''
    );
  } catch {
    return false;
  }
}

/** The addresses the library holds, by service, keeping only those still worth believing. */
export function readPrivateAddresses(row: SettingsRow | undefined): Record<string, string> {
  const found: Record<string, string> = {};
  for (const [service, stamped] of Object.entries(row?.values ?? {})) {
    // A service name as the routes table spells one; anything else is not ours to interpret.
    if (!/^[a-z][a-z0-9-]*$/.test(service)) continue;
    const value = stamped.value;
    if (value && 'string' in value && storable(value.string))
      found[service] = trimmed(value.string);
  }
  return found;
}

/**
 * What to write when the address a device just reached is not what the library says; null when there
 * is nothing to do.
 *
 * Healing rather than writing once: the tailnet name can be changed, and a machine renamed, and the
 * stored address is then wrong with nothing on the server to correct it from — the public table no
 * longer names it. Every visit from a device that can see the real address is a chance to put it
 * right, and costs a write only when it actually differs.
 *
 * Nothing is ever cleared here. A probe fails for the ordinary reason that the viewer is off the
 * tailnet just now, which is exactly when the address cannot be verified — and forgetting it then
 * would erase the household's only copy at the moment it is least able to prove it.
 */
export function healed(
  stored: Record<string, string>,
  service: string,
  reached: string | null,
): Record<string, ConfigValue | null> | null {
  if (!reached || !storable(reached)) return null;
  const url = trimmed(reached);
  return stored[service] === url ? null : { [service]: { string: url } };
}

/**
 * The addresses to try for a service, the stored one first.
 *
 * First because it is the one the table cannot name: on the public name there is nothing else to
 * try, and on the tailnet or the LAN it is the same address the table would have given anyway. An
 * entry the table already names is dropped rather than probed twice.
 */
export function ahead(stored: string | undefined, entries: Entry[] = []): Entry[] {
  if (!stored) return entries;
  return [{ url: stored }, ...entries.filter((entry) => trimmed(entry.url) !== stored)];
}
