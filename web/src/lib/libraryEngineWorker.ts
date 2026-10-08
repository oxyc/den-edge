// Dedicated production Worker for staged library startup. Unlike the projection Worker, this owns a live
// LibraryLog: open includes durable pending work, and hydration hands that exact state to the page.

import { LibraryEngine, type LibraryEngineReply, type LibraryEngineRequest } from './libraryEngine';

const engine = new LibraryEngine();
let requests = Promise.resolve();

function message(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

self.onmessage = (event: MessageEvent<LibraryEngineRequest>) => {
  const request = event.data;
  // Retained writes must finish before a later hydration chunk snapshots their log state.
  requests = requests.then(async () => {
    let reply: LibraryEngineReply;
    try {
      reply = { id: request.id, value: await engine.request(request) };
    } catch (error) {
      reply = { id: request.id, error: message(error) };
    }
    self.postMessage(reply);
  });
};
