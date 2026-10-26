import { readdir, readFile } from 'node:fs/promises';

const assets = new URL('../dist/assets/', import.meta.url);
const workers = (await readdir(assets)).filter(
  (name) => name.startsWith('libraryServiceWorker-') && name.endsWith('.js'),
);
const sharedWorkers = (await readdir(assets)).filter(
  (name) => name.startsWith('libraryServiceSharedWorker-') && name.endsWith('.js'),
);

if (workers.length !== 1)
  throw new Error(`expected one built library service worker, found ${workers.length}`);
if (sharedWorkers.length !== 0)
  throw new Error(`expected no duplicate shared worker artifact, found ${sharedWorkers.length}`);

const source = await readFile(new URL(workers[0], assets), 'utf8');
const unresolvedRune = source.match(
  /\$(?:state|derived|effect|props|bindable|inspect|host)(?:\.|\()/,
)?.[0];
if (unresolvedRune)
  throw new Error(`library service worker contains unresolved Svelte rune ${unresolvedRune}`);
if (!source.includes('den-library-connected'))
  throw new Error('library service worker is missing its SharedWorker broker');

// The page and Worker are one content-addressed pair: a cached old page names its old Worker, never a newer build's
// changed library protocol. Keep this invariant checked because render-facing protocol revisions rely on it.
const pageAssets = (await readdir(assets)).filter(
  (name) => name.endsWith('.js') && name !== workers[0],
);
const workerReferences = (
  await Promise.all(
    pageAssets.map(async (name) => ({
      name,
      source: await readFile(new URL(name, assets), 'utf8'),
    })),
  )
).filter(({ source }) => source.includes(workers[0]));
// Budget E2E builds deliberately disable the SharedWorker transport so an isolated fixture can route every request;
// their browser entry is therefore the only reference. Production builds must still contain both entry points.
const expectedReferences = process.env.DEN_E2E === '1' ? 1 : 2;
if (workerReferences.length !== expectedReferences)
  throw new Error(
    `expected ${expectedReferences} browser worker reference(s) to name ${workers[0]}, found ${workerReferences.length}`,
  );
if (
  process.env.DEN_E2E !== '1' &&
  !workerReferences.some(({ name }) => name.startsWith('libraryServiceSharedWorkerTransport-'))
)
  throw new Error(`expected the lazy SharedWorker transport to reference ${workers[0]}`);
