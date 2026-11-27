import { parseRoute, routePath } from './route';
import { appHistoryUrl, currentAppPath } from './runtimeUrl';

/**
 * Where the replacement profile opens. A title's page stays (season and episode kept) so switching profile does not
 * lose the title being looked at; the page itself withholds playback from a profile whose ceiling blocks it. Its
 * play/trailer/source request is dropped: the new profile chooses and authorizes its own playback. Every other route
 * becomes Home, so a Kid never lands on the Owner's Settings.
 */
export function profileRouteAfterSwitch(path: string): string {
  const route = parseRoute(path);
  if (route.page !== 'title') return '/';
  const { play: _play, filename: _filename, trailer: _trailer, ...safe } = route;
  return routePath(safe);
}

/**
 * Retire the current profile's navigation scope without adding a Back destination. The address is replaced at once:
 * the keyed profile tree is rebuilt from the address, so a Router that has not yet written its own (it settles
 * asynchronously) would otherwise leave the new profile on the page the last one was on — a Kid landing on Settings
 * behind the Owner PIN. Router also handles the event, flushing its pending address before it is destroyed.
 */
export function resetProfileNavigation(
  target: EventTarget = document,
  address: Pick<History, 'replaceState'> = history,
  path: string = currentAppPath(),
  historyUrl: (path: string) => string = appHistoryUrl,
): void {
  const next = profileRouteAfterSwitch(path);
  address.replaceState(null, '', historyUrl(next));
  // Not `replace: true`: that is Router's in-place address rewrite for a growing query and leaves the page drawn. The
  // address already says `next`, so following it opens that route without pushing an entry.
  target.dispatchEvent(new CustomEvent('den:navigate', { detail: { path: next } }));
}
