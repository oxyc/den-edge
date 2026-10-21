// Tizen 5.5's Chromium 69-only layer. This file is selected by the legacy Samsung build before the ordinary TV
// compatibility module, and is never reachable from Den Web, LG, or newer Samsung bundles.
import 'core-js/actual/global-this';
import 'core-js/actual/string/match-all';
import 'core-js/actual/string/replace-all';
import 'core-js/actual/object/from-entries';
import 'core-js/actual/promise/all-settled';
import 'core-js/actual/queue-microtask';
import './compat';

// Chromium 69 predates Intl.DisplayNames. Names are presentation only; retaining the canonical language/region
// code is preferable to making Settings, Explore, details, or the player fail to load on a 2020 Samsung TV.
if (!('DisplayNames' in Intl)) {
  Object.defineProperty(Intl, 'DisplayNames', {
    configurable: true,
    value: class {
      of(code: string) {
        return code;
      }
    },
  });
}
