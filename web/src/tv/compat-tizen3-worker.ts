// Chromium 47 / Tizen 3 compatibility shared by the page and Den's owned Workers. Keep DOM-only observers out of
// this module: Workers have no window or document, and receive this entry independently from the page bundle.
import 'core-js/actual/url-search-params';
import 'abortcontroller-polyfill/dist/polyfill-patch-fetch';
import './compat-legacy';
