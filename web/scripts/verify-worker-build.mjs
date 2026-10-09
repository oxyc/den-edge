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
