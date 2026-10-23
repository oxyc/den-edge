// Explicit maintenance command, not part of normal builds. Generated TV bindings are checked in; web keeps its
// original artifacts. Supply a clean den-core source archive matching every hash in the browser vendor manifest.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  browserCore,
  tvCore,
  coreManifest,
  sha256,
  verifyTvCore,
  checkTvCoreInventory,
} from './tv-core-artifacts.mjs';

const source = process.argv[2] && resolve(process.argv[2]);
if (!source) throw new Error('Usage: node scripts/build-tv-core.mjs /path/to/pinned/den-core');
const manifest = coreManifest();
if (existsSync(tvCore)) checkTvCoreInventory();
const verifiedSources = new Map();
for (const [file, expected] of Object.entries(manifest.sources)) {
  const bytes = readFileSync(join(source, file));
  if (sha256(bytes) !== expected)
    throw new Error(`den-core source differs from browser policy: ${file}`);
  verifiedSources.set(file, bytes);
}
const bindgen = process.env.WASM_BINDGEN ?? 'wasm-bindgen';
const version = (command) => execFileSync(command, ['--version'], { encoding: 'utf8' }).trim();
if (version(bindgen) !== `wasm-bindgen ${manifest.wasmBindgen}`)
  throw new Error(`Expected wasm-bindgen ${manifest.wasmBindgen}`);
if (!version('rustc').startsWith(`rustc ${manifest.rust} `))
  throw new Error(`Expected Rust ${manifest.rust} with rust-src installed`);

const scratch = mkdtempSync(join(tmpdir(), 'den-tv-core-build-'));
console.log(`TV core build evidence: ${scratch}`);
// Compile only the verified inputs, not an unchecked build.rs/.cargo config or other leftovers in the supplied
// checkout. Staging the bytes just hashed also avoids a concurrent source edit between verification and build.
const sourceRoot = join(scratch, 'source');
for (const [file, bytes] of verifiedSources) {
  const destination = join(sourceRoot, file);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, bytes);
}
const rustflags = '-Zunstable-options -Cpanic=immediate-abort -C target-feature=-reference-types';
const sysroot = execFileSync('rustc', ['--print', 'sysroot'], { encoding: 'utf8' }).trim();
// Panic locations survive removing debug names. Normalize build-machine paths for reproducibility and avoid
// publishing developer directory names in the binary. Encoded flags also handle source paths containing spaces.
const encodedFlags = [
  '-Z',
  'unstable-options',
  '-C',
  'panic=immediate-abort',
  '-C',
  'target-feature=-reference-types',
  `--remap-path-prefix=${sourceRoot}=/den-core`,
  `--remap-path-prefix=${process.env.CARGO_HOME ?? join(homedir(), '.cargo')}=/cargo`,
  `--remap-path-prefix=${sysroot}=/rust-toolchain`,
].join('\x1f');
// Disabling only our crate's target feature is insufficient: the precompiled Rust std still declares reference
// types, making wasm-bindgen re-enable a second table. Rebuild std with the same flag. RUSTC_BOOTSTRAP enables
// only this explicit build-std maintenance invocation on the source-pinned compiler; runtime/build users need
// neither Rust nor nightly tools. Chrome 87 rejects the stock module's two tables; the rebuilt module is tested
// in the actual engine, not inferred from JS syntax targets.
execFileSync(
  'cargo',
  [
    'build',
    '-Z',
    'build-std=std,panic_abort',
    '--locked',
    '--release',
    '-p',
    'den-core-web',
    '-p',
    'den-core-web-assistant',
    '--target',
    'wasm32-unknown-unknown',
  ],
  {
    cwd: sourceRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      RUSTC_BOOTSTRAP: '1',
      RUSTFLAGS: rustflags,
      CARGO_ENCODED_RUSTFLAGS: encodedFlags,
      CARGO_TARGET_DIR: join(scratch, 'target'),
    },
  },
);
// Cargo unifies features across packages in one invocation. The recovery crate enables den-sync/recovery-kdf;
// compiling it with the ordinary core would silently put Argon2 back into that core. A distinct invocation and
// target directory are therefore part of the capability boundary, not merely a build optimization.
const recoveryTarget = join(scratch, 'target-recovery');
execFileSync(
  'cargo',
  [
    'build',
    '-Z',
    'build-std=std,panic_abort',
    '--locked',
    '--release',
    '-p',
    'den-core-web-recovery',
    '--target',
    'wasm32-unknown-unknown',
  ],
  {
    cwd: sourceRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      RUSTC_BOOTSTRAP: '1',
      RUSTFLAGS: rustflags,
      CARGO_ENCODED_RUSTFLAGS: encodedFlags,
      CARGO_TARGET_DIR: recoveryTarget,
    },
  },
);
const generated = join(scratch, 'generated');
for (const [crate, name, target = join(scratch, 'target')] of [
  ['den_core_web', 'den_core'],
  ['den_core_web_assistant', 'den_core_assistant'],
  ['den_core_web_recovery', 'den_core_recovery', recoveryTarget],
]) {
  execFileSync(
    bindgen,
    [
      '--target',
      'web',
      '--remove-name-section',
      '--out-dir',
      generated,
      '--out-name',
      name,
      join(target, 'wasm32-unknown-unknown/release', `${crate}.wasm`),
    ],
    { stdio: 'inherit' },
  );
}
mkdirSync(tvCore, { recursive: true });
for (const name of [
  'index.js',
  'index.d.ts',
  'assistant.js',
  'assistant.d.ts',
  'recovery.js',
  'recovery.d.ts',
  'LICENSE',
])
  cpSync(join(browserCore, name), join(tvCore, name));
cpSync(generated, join(tvCore, 'generated'), { recursive: true });
const names = [
  'LICENSE',
  'index.js',
  'index.d.ts',
  'assistant.js',
  'assistant.d.ts',
  'recovery.js',
  'recovery.d.ts',
  ...readdirSync(generated).map((name) => `generated/${name}`),
].sort();
writeFileSync(
  join(tvCore, 'SOURCE.json'),
  JSON.stringify(
    {
      schema: 1,
      sourceManifest: '../den-core/SOURCE.json',
      sourceDigest: manifest.sourceDigest,
      rust: manifest.rust,
      wasmBindgen: manifest.wasmBindgen,
      rustflags,
      normalizedBuildPaths: true,
      removeNameSection: true,
      buildStd: ['std', 'panic_abort'],
      artifacts: Object.fromEntries(
        names.map((name) => [name, sha256(readFileSync(join(tvCore, name)))]),
      ),
    },
    null,
    2,
  ) + '\n',
);
verifyTvCore();
console.log('TV-only den-core generated and source/artifact hashes verified');
