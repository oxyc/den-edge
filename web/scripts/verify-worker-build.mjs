import { readdir, readFile } from 'node:fs/promises';

const assets = new URL('../dist/assets/', import.meta.url);
const workers = (await readdir(assets)).filter(
  (name) => name.startsWith('libraryServiceWorker-') && name.endsWith('.js'),
);

if (workers.length !== 1)
  throw new Error(`expected one built library service worker, found ${workers.length}`);

const source = await readFile(new URL(workers[0], assets), 'utf8');
const unresolvedRune = source.match(
  /\$(?:state|derived|effect|props|bindable|inspect|host)(?:\.|\()/,
)?.[0];
if (unresolvedRune)
  throw new Error(`library service worker contains unresolved Svelte rune ${unresolvedRune}`);

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
if (workerReferences.length !== 1)
  throw new Error(
    `expected exactly one page asset to name content-hashed Worker ${workers[0]}, found ${workerReferences.length}`,
  );
