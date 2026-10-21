// Chromium 47 / Tizen 3 page compatibility. These globals are installed once, before any Svelte screen evaluates,
// so ordinary components keep using the standard browser APIs without target-specific branches or fallbacks.
import './compat-tizen3-worker';
import 'intersection-observer';
import { ResizeObserver as ResizeObserverPolyfill } from '@juggle/resize-observer';

if (!('ResizeObserver' in globalThis)) {
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: ResizeObserverPolyfill,
  });
}
