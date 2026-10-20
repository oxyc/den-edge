#!/usr/bin/env node

// Generate TV artifacts without touching the normal web build output.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { TV_CSP } from './tv-csp.mjs';

const webRoot = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const platform = args.shift();
const option = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const usage = (message) => {
  if (message) console.error(`Error: ${message}\n`);
  console.error(
    'Usage: node scripts/tv-package.mjs <webos|tizen> --url https://host/path [--version 0.1.0]',
  );
  process.exit(2);
};
if (!['webos', 'tizen'].includes(platform)) usage('platform must be webos or tizen');
const urlText = option('--url');
if (!urlText) usage('--url is required');
let remote;
try {
  remote = new URL(urlText);
} catch {
  usage('--url must be a valid URL');
}
if (remote.protocol !== 'https:') usage('--url must use HTTPS');
if (remote.username || remote.password) usage('--url must not contain embedded credentials');
if (remote.hash) usage('--url must not contain a fragment');
const hostname = remote.hostname.toLowerCase().replace(/^\[|\]$/g, '');
if (['localhost', '127.0.0.1', '::1'].includes(hostname))
  usage('--url must be reachable from the TV; localhost/loopback is not allowed');
const version = option('--version') ?? '0.1.0';
if (!/^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})$/.test(version))
  usage('--version must have three numeric components of up to 9 digits without leading zeroes');

const packageRoot = resolve(
  webRoot,
  'tv-packages',
  ...(args.includes('--smoke-test') ? ['smoke-test'] : []),
  platform,
);
const shell = join(packageRoot, 'shell');
const packages = join(packageRoot, 'packages');
const icon = join(
  webRoot,
  'tv-packaging',
  'assets',
  platform === 'tizen' ? 'icon-117.png' : 'icon-80.png',
);
const largeIcon = join(webRoot, 'tv-packaging', 'assets', 'icon-130.png');
if (!existsSync(icon) || !existsSync(largeIcon))
  throw new Error('TV icons are missing; run node scripts/tv-icons.mjs first');
function prepareShell() {
  // Validate all inputs/build metadata before replacing a previously prepared shell.
  rmSync(shell, { recursive: true, force: true });
  mkdirSync(shell, { recursive: true });
  mkdirSync(packages, { recursive: true });
  cpSync(icon, join(shell, 'icon.png'));
}

if (platform === 'tizen') {
  const versionParts = version.split('.').map(Number);
  if (versionParts[0] > 255 || versionParts[1] > 255 || versionParts[2] > 65535)
    usage('Tizen --version components must be within 0-255, 0-255, and 0-65535');
  const apiText = process.env.DEN_TV_API_ORIGIN;
  const serviceText = process.env.DEN_TV_SERVICE_ORIGIN ?? apiText;
  const profile = option('--profile');
  const prepare = args.includes('--prepare');
  if (!apiText) usage('DEN_TV_API_ORIGIN is required for a bundled Tizen package');
  if (!profile && !prepare)
    usage('--profile is required to sign a Tizen .wgt (or use --prepare for unsigned inspection)');
  let api;
  try {
    api = new URL(apiText);
  } catch {
    usage('DEN_TV_API_ORIGIN must be a valid URL');
  }
  if (
    api.protocol !== 'https:' ||
    api.username ||
    api.password ||
    api.hash ||
    api.pathname !== '/' ||
    api.search
  )
    usage(
      'DEN_TV_API_ORIGIN must be an exact HTTPS origin without credentials, path, query, or fragment',
    );
  if (remote.origin !== api.origin)
    usage('--url and DEN_TV_API_ORIGIN must name the same origin for a Tizen package');
  let service;
  try {
    service = new URL(serviceText);
  } catch {
    usage('DEN_TV_SERVICE_ORIGIN must be a valid URL');
  }
  if (
    service.protocol !== 'https:' ||
    service.username ||
    service.password ||
    service.hash ||
    service.pathname !== '/' ||
    service.search
  )
    usage(
      'DEN_TV_SERVICE_ORIGIN must be an exact HTTPS origin without credentials, path, query, or fragment',
    );
  const outDir = process.env.DEN_TV_OUT_DIR ?? 'dist-tv-tizen-package';
  if (!/^dist-tv-tizen-package(?:-e2e-\d+)?$/.test(outDir))
    usage('DEN_TV_OUT_DIR must name an isolated Tizen package output directory');
  const built = join(webRoot, outDir);
  if (!existsSync(join(built, 'index.html')))
    throw new Error(
      'Build the bundled artifact first with DEN_TV_PACKAGED=1 npm run build:tv:tizen',
    );
  const builtIndex = readFileSync(join(built, 'index.html'), 'utf8');
  if (/-e2e-/.test(outDir) || existsSync(join(built, 'test', 'player.html')))
    throw new Error('Refusing to package a TV E2E fixture build for distribution');
  const metadataPath = join(built, 'den-tv-package.json');
  if (!existsSync(metadataPath))
    throw new Error('Bundled artifact metadata is missing; rebuild with DEN_TV_PACKAGED=1');
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  } catch {
    throw new Error('Bundled artifact metadata is invalid');
  }
  if (
    metadata.packaged !== true ||
    metadata.platform !== 'tizen' ||
    metadata.apiOrigin !== api.origin ||
    metadata.serviceOrigin !== service.origin ||
    metadata.e2e !== false
  )
    throw new Error(
      'Bundled artifact metadata does not match packaged Tizen API/service origin settings',
    );
  if (/\b(?:src|href)="\/(?:assets|manifest)/.test(builtIndex))
    throw new Error(
      'Bundled Tizen index still contains root-absolute asset URLs; rebuild with packaged base ./',
    );
  const samsungBridge =
    '<script type="text/javascript" src="$WEBAPIS/webapis/webapis.js"></script>';
  if (!builtIndex.includes(samsungBridge))
    throw new Error(
      'Bundled Tizen index is missing Samsung Web API bridge; rebuild the packaged bundle',
    );
  prepareShell();
  cpSync(built, shell, { recursive: true });
  // The app icon is deliberately copied after the build so a public favicon cannot replace
  // the Tizen Studio-compatible 117x117 development icon.
  cpSync(icon, join(shell, 'icon.png'));
  // WARP is a network permission, not an executable-code permission. Den media and user-installed
  // addons can use origins unknown at packaging time, so network access is broad while CSP keeps all
  // executable resources inside the signed widget.
  writeFileSync(
    join(shell, 'config.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<widget xmlns="http://www.w3.org/ns/widgets" xmlns:tizen="http://tizen.org/ns/widgets" id="http://den.app" version="${version}" viewmodes="maximized">
  <tizen:application id="DenTvApp1X.Den" package="DenTvApp1X" required_version="8.0" />
  <content src="index.html" /><icon src="icon.png" /><name>Den</name>
  <tizen:profile name="tv-samsung" />
  <tizen:metadata key="http://samsung.com/tv/metadata/devel.api.version" value="8.0" />
  <access origin="*" subdomains="true" />
  <tizen:content-security-policy>${TV_CSP}</tizen:content-security-policy>
  <tizen:privilege name="http://tizen.org/privilege/internet" />
  <tizen:privilege name="http://tizen.org/privilege/tv.inputdevice" />
  <tizen:setting pointing-device-support="disable" />
</widget>\n`,
  );
  if (prepare) {
    console.log(
      'Prepared unsigned Tizen shell for XML/assets inspection; no SDK or signing command was run.',
    );
  } else {
    const build = spawnSync('tizen', ['build-web', '--', shell], { encoding: 'utf8' });
    if (build.error?.code === 'ENOENT') {
      console.error(
        'Tizen: tizen CLI is missing; bundled shell/config.xml is ready but no .wgt was created.',
      );
      process.exitCode = 1;
    } else if (build.status !== 0) {
      console.error(`Tizen build-web failed: ${(build.stderr || build.stdout || '').trim()}`);
      process.exitCode = 1;
    } else {
      const result = spawnSync(
        'tizen',
        ['package', '-t', 'wgt', '-s', profile, '-o', packages, '--', join(shell, '.buildResult')],
        { encoding: 'utf8' },
      );
      if (result.error?.code === 'ENOENT') {
        console.error(
          'Tizen: tizen CLI is missing; bundled shell/config.xml is ready but no .wgt was created.',
        );
        process.exitCode = 1;
      } else if (result.status !== 0) {
        console.error(
          `Tizen packaging/signing failed: ${(result.stderr || result.stdout || '').trim()}`,
        );
        process.exitCode = 1;
      }
    }
  }
  console.log(`Bundled Tizen artifact copied from ${built}`);
} else {
  prepareShell();
  const redirect = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=1920,height=1080,initial-scale=1,viewport-fit=cover"><title>Den</title></head>
<body><p>Opening Den…</p><script>
const target = ${JSON.stringify(remote.href)};
window.addEventListener('keydown', (event) => { if (event.key === 'Escape' || event.key === 'Backspace' || event.keyCode === 461) history.back(); });
location.replace(target);
</script></body></html>\n`;
  writeFileSync(join(shell, 'index.html'), redirect);
  writeFileSync(
    join(shell, 'appinfo.json'),
    `${JSON.stringify(
      {
        id: 'com.den.edge.tv',
        version,
        vendor: 'Den',
        type: 'web',
        title: 'Den',
        main: 'index.html',
        icon: 'icon.png',
        largeIcon: 'largeicon.png',
        resolution: '1920x1080',
        disableBackHistoryAPI: true,
        // Required by current webOS CLI guidance; this launcher uses no Luna service APIs.
        requiredACG: [],
      },
      null,
      2,
    )}\n`,
  );
  cpSync(largeIcon, join(shell, 'largeicon.png'));
  const result = spawnSync('ares-package', [shell, '--outdir', packages], { encoding: 'utf8' });
  if (result.error?.code === 'ENOENT') {
    console.error('webOS: ares-package is missing; shell is ready but no .ipk was created.');
    process.exitCode = 1;
  } else if (result.status !== 0) {
    console.error(`webOS packaging failed: ${(result.stderr || result.stdout || '').trim()}`);
    process.exitCode = 1;
  }
}
console.log(`Generated ${platform} shell at ${shell}`);
if (process.exitCode)
  console.error('No new package was produced; any existing packages are unchanged.');
else if (platform === 'webos')
  console.log(`Created ${join(packages, `com.den.edge.tv_${version}_all.ipk`)}`);
else if (args.includes('--prepare'))
  console.log(
    'No signed Tizen package was requested (--prepare only validates the unsigned shell).',
  );
else console.log(`Created a signed Tizen package in ${packages}`);
console.log(`Remote origin configured: ${remote.origin}`);
