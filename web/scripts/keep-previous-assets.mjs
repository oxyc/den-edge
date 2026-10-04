// Carries the immediately-previous release's hashed chunks forward into this build's `dist/assets/`, so a
// browser whose service worker still runs that release's shell (`public/sw.js`) can still fetch the dynamic
// imports it lazily loads once this build's image becomes `:latest`. Without this, those filenames 404 against
// the new image (it only ever carried its own build's assets), and a kept old shell renders a half page — the
// billboard draws, but anything behind a chunk den-edge no longer has never does.
//
// Only ever keeps ONE generation back: the service worker only ever asks for the release a page runs and the
// one it is moving to (`prune` in `public/sw.js`), so nothing older than that is ever requested.
//
// Runs from the Dockerfile, after `npm run build`: `/previous` is the previous release's published runtime
// image, copied in by `COPY --from=previous / /previous` — its root is `scratch` (so empty) on the very first
// build, or when docker-publish.yml could not resolve a `:latest` to build from.
import { access, copyFile, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const distAssets = join(dist, 'assets');
const manifestName = 'release-manifest.json';
const previousWeb = '/previous/web';

async function listAssets(dir) {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

async function readManifest(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const currentFiles = await listAssets(distAssets);
// Every name is already content-addressed, so a stable id for "this exact set of files" is just a hash of the
// (sorted) name list — nothing here needs the release version.
const currentId = createHash('sha256').update(currentFiles.join('\n')).digest('hex');

const previousManifest = await readManifest(join(previousWeb, manifestName));
// A patch rebuild reproduces the same release's files: carry forward what IT called "previous", not itself,
// so the generation that is genuinely a release back is never dropped in favour of a no-op rebuild of this one.
const carryForward =
  previousManifest?.current?.id === currentId
    ? previousManifest.previous
    : previousManifest?.current;

let copied = 0;
for (const name of carryForward?.files ?? []) {
  const to = join(distAssets, name);
  if (await exists(to)) continue; // this build already produced a file of that name (same hash, same bytes)
  try {
    await copyFile(join(previousWeb, 'assets', name), to);
    copied++;
    // Carry its precompressed siblings too (den-edge serves these directly, web.rs) rather than recompressing —
    // the previous build already made them. Not every file has one: precompress.mjs skips a variant that
    // doesn't shrink the file, and this release may predate precompression entirely.
    for (const suffix of ['.gz', '.br']) {
      if (await exists(join(previousWeb, 'assets', name + suffix))) {
        await copyFile(join(previousWeb, 'assets', name + suffix), to + suffix);
      }
    }
  } catch (error) {
    console.warn(`den: could not carry forward previous asset ${name}:`, error.message);
  }
}

await writeFile(
  join(dist, manifestName),
  JSON.stringify({
    current: { id: currentId, files: currentFiles },
    previous: carryForward ?? null,
  }),
);
console.log(
  `den: kept ${carryForward?.files?.length ?? 0} previous-release asset(s), carried forward ${copied} missing`,
);
