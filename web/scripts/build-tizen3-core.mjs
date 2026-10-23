// Explicit maintenance command. Tizen 3's Chromium 47 has no WebAssembly, so this builds only the ordinary
// den-sync policy behind a small C ABI and converts it to checked-in JavaScript. Browser, webOS and newer Tizen
// builds keep the existing Wasm artifact and never parse or download this fallback.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { coreManifest, sha256 } from './tv-core-artifacts.mjs';

const source = process.argv[2] && resolve(process.argv[2]);
if (!source) throw new Error('Usage: node scripts/build-tizen3-core.mjs /path/to/pinned/den-core');
const manifest = coreManifest();
const verifiedSources = new Map();
const omittedSources = new Set(['crates/den-sync/src/recovery.rs']);
for (const [file, expected] of Object.entries(manifest.sources)) {
  const bytes = readFileSync(join(source, file));
  if (omittedSources.has(file)) continue;
  if (sha256(bytes) !== expected)
    throw new Error(`den-core source differs from browser policy: ${file}`);
  verifiedSources.set(file, bytes);
}

const wasm2js = process.env.WASM2JS ?? 'wasm2js';
const wasmOpt = process.env.WASM_OPT ?? resolve(dirname(wasm2js), 'wasm-opt');
const terser = process.env.TERSER ?? resolve('node_modules/.bin/terser');
const wasm2jsVersion = execFileSync(wasm2js, ['--version'], { encoding: 'utf8' }).trim();
if (wasm2jsVersion !== 'wasm2js version 133 (version_133)')
  throw new Error(`Expected Binaryen wasm2js 133, got ${wasm2jsVersion}`);
if (
  execFileSync(wasmOpt, ['--version'], { encoding: 'utf8' }).trim() !==
  'wasm-opt version 133 (version_133)'
)
  throw new Error('Expected Binaryen wasm-opt 133 beside wasm2js');
if (!existsSync(terser)) throw new Error(`Terser is missing: ${terser}`);
if (
  !execFileSync('rustc', ['--version'], { encoding: 'utf8' }).startsWith(`rustc ${manifest.rust} `)
)
  throw new Error(
    `Expected Rust ${manifest.rust} with the wasm32-unknown-unknown target installed`,
  );

const scratch = mkdtempSync(join(tmpdir(), 'den-tizen3-core-build-'));
console.log(`Tizen 3 core build evidence: ${scratch}`);
const sourceRoot = join(scratch, 'source');
for (const [file, bytes] of verifiedSources) {
  const destination = join(sourceRoot, file);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, bytes);
}

// wasm-bindgen's current string return ABI uses Wasm multi-value, which wasm2js cannot lower. This transport-only
// binding exposes the same den_sync::evaluate through pointers. It is generated into the verified staging tree;
// it is not a second policy implementation and cannot drift from den-sync.
const rawBinding = `use std::{mem, slice, str};

#[no_mangle]
pub fn den_alloc(len: usize) -> *mut u8 {
    let mut value = Vec::<u8>::with_capacity(len);
    let pointer = value.as_mut_ptr();
    mem::forget(value);
    pointer
}

#[no_mangle]
pub unsafe fn den_free(pointer: *mut u8, len: usize) {
    if len != 0 { drop(Vec::from_raw_parts(pointer, len, len)); }
}

#[no_mangle]
pub unsafe fn den_evaluate(input_pointer: *const u8, input_len: usize, output: *mut usize) {
    let input = str::from_utf8_unchecked(slice::from_raw_parts(input_pointer, input_len));
    let mut answer = den_sync::evaluate_core(input).into_bytes().into_boxed_slice();
    *output = answer.as_mut_ptr() as usize;
    *output.add(1) = answer.len();
    mem::forget(answer);
}
`;
writeFileSync(join(sourceRoot, 'bindings/web/src/lib.rs'), rawBinding);
// Recovery setup belongs on a current browser. Keep even the lightweight make/read operations out of the legacy
// artifact, as well as the deliberately omitted Argon2 module, while retaining request-schema compatibility.
writeFileSync(
  join(sourceRoot, 'crates/den-sync/src/recovery.rs'),
  `use serde_json::Value;\npub fn code(_: &str) -> Result<Value, String> { Err("unsupported".into()) }\npub fn read(_: &str) -> Result<Value, String> { Err("unsupported".into()) }\npub fn derive(_: &str) -> Result<Value, String> { Err("unsupported".into()) }\n`,
);
const sysroot = execFileSync('rustc', ['--print', 'sysroot'], { encoding: 'utf8' }).trim();
const encodedFlags = [
  '-C',
  'target-feature=-reference-types,-multivalue',
  `--remap-path-prefix=${sourceRoot}=/den-core`,
  `--remap-path-prefix=${process.env.CARGO_HOME ?? join(homedir(), '.cargo')}=/cargo`,
  `--remap-path-prefix=${sysroot}=/rust-toolchain`,
].join('\x1f');
execFileSync(
  'cargo',
  ['build', '--locked', '--release', '-p', 'den-core-web', '--target', 'wasm32-unknown-unknown'],
  {
    cwd: sourceRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      RUSTC_BOOTSTRAP: '1',
      RUSTFLAGS: '-C target-feature=-reference-types,-multivalue',
      CARGO_ENCODED_RUSTFLAGS: encodedFlags,
      CARGO_TARGET_DIR: join(scratch, 'target'),
    },
  },
);

const wasm = join(scratch, 'target/wasm32-unknown-unknown/release/den_core_web.wasm');
const optimizedWasm = join(scratch, 'den_core_bg.optimized.wasm');
const converted = join(scratch, 'den_core.converted.js');
const generated = join(sourceRoot, 'web-tizen3/generated/den_core.js');
mkdirSync(dirname(generated), { recursive: true });
// Binaryen 133's integrated wasm2js optimizer asserts on Rust's unaligned stores. Optimizing the Wasm first and
// running the converter's reliable lowering path is equivalent; Terser then performs the JS-level compression.
execFileSync(wasmOpt, [wasm, '-O3', '-o', optimizedWasm], { stdio: 'inherit' });
execFileSync(wasm2js, [optimizedWasm, '-o', converted], { stdio: 'inherit' });
execFileSync(terser, [converted, '--compress', '--mangle', '--ecma', '5', '--output', generated], {
  stdio: 'inherit',
});
const moduleTail =
  'export var memory=retasmFunc.memory;export var den_alloc=retasmFunc.den_alloc;export var den_evaluate=retasmFunc.den_evaluate;export var den_free=retasmFunc.den_free;export var __data_end=retasmFunc.__data_end;export var __heap_base=retasmFunc.__heap_base;';
const globalTail =
  ';(typeof self!=="undefined"?self:globalThis).DenTizen3Core={memory:retasmFunc.memory,den_alloc:retasmFunc.den_alloc,den_evaluate:retasmFunc.den_evaluate,den_free:retasmFunc.den_free};';
const convertedCode = readFileSync(generated, 'utf8');
if (!convertedCode.endsWith(moduleTail))
  throw new Error('wasm2js/Terser export seam changed; refusing an unreviewed legacy core');
writeFileSync(generated, convertedCode.slice(0, -moduleTail.length) + globalTail);

const destination = resolve('src/vendor/den-core-tizen3');
mkdirSync(join(destination, 'generated'), { recursive: true });
rmSync(join(destination, 'generated/den_core.js'), { force: true });
writeFileSync(join(destination, 'generated/den_core.js'), readFileSync(generated));
const artifacts = {
  'generated/den_core.js': sha256(readFileSync(join(destination, 'generated/den_core.js'))),
  'index.js': sha256(readFileSync(join(destination, 'index.js'))),
  'index.d.ts': sha256(readFileSync(join(destination, 'index.d.ts'))),
};
writeFileSync(
  join(destination, 'SOURCE.json'),
  `${JSON.stringify(
    {
      schema: 1,
      sourceManifest: '../den-core/SOURCE.json',
      sourceDigest: manifest.sourceDigest,
      rust: manifest.rust,
      binaryen: 133,
      rustflags: '-C target-feature=-reference-types,-multivalue',
      rawBindingSha256: sha256(Buffer.from(rawBinding)),
      excludes: ['assistant', 'recovery'],
      omittedSources: [...omittedSources],
      artifacts,
    },
    null,
    2,
  )}\n`,
);
console.log(`Tizen 3 JavaScript core generated (${readFileSync(generated).byteLength} bytes)`);
