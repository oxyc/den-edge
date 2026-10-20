import { apiUrl, appHistoryUrl } from '../lib/runtimeUrl';

// Installed before the shared application evaluates, independently in the page and each dedicated Worker.
// Hosted LG and packaged Samsung builds can share the existing device API origin. This is a URL transport
// adapter, not an auth adapter: it moves only allowlisted Den paths and never credentials for arbitrary hosts.
if (__DEN_TV_API_ORIGIN__) {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => {
    if (input instanceof Request) {
      const url = apiUrl(input.url);
      return nativeFetch(url === input.url ? input : new Request(url, input), init);
    }
    return nativeFetch(apiUrl(String(input)), init);
  };
  if (typeof XMLHttpRequest !== 'undefined') {
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (
      method: string,
      url: string | URL,
      async: boolean = true,
      username?: string | null,
      password?: string | null,
    ) {
      return open.call(this, method, apiUrl(String(url)), async, username, password);
    };
  }
  if (typeof globalThis.navigator?.sendBeacon === 'function') {
    const beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, data) => beacon(apiUrl(String(url)), data);
  }
  if (typeof window !== 'undefined') {
    for (const method of ['pushState', 'replaceState'] as const) {
      const native = history[method].bind(history);
      history[method] = (data, unused, url) =>
        native(data, unused, url == null ? url : appHistoryUrl(url));
    }
  }
}
