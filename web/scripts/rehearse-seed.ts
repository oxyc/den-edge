// Built by `npm run rehearse:household` (`rehearse-seed.html`) and served beside the app, never part of it: writes a
// library kept only in this browser with the app's own code (`LibraryLog.openLocal`, `writeRows`), as a browser that
// used Den before households has one, and points this browser at it. The rehearsal calls `window.denSeed`.

import { LibraryLog } from '../src/lib/log';
import type { Row } from '../src/lib/wire';

async function seed(rows: Row[], { v3 = false } = {}): Promise<string> {
  const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  const log = await LibraryLog.openLocal(key);
  if (!log) throw new Error('this browser keeps no library');
  if (!(await log.writeRows(rows))) throw new Error('the rows were not kept');
  if (v3 && !(await log.switchWebOnly())) throw new Error('the library was not switched to v3');
  log.close();
  localStorage.setItem('den.localLibrary', key);
  // It chose to look around rather than link a TV, which is how a browser comes to keep a library.
  localStorage.setItem('den.browsing', '1');
  return key;
}

(window as unknown as { denSeed: typeof seed }).denSeed = seed;
