#!/usr/bin/env node

// Generate TV artifacts without touching the normal web build output.
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

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
rmSync(shell, { recursive: true, force: true });
mkdirSync(shell, { recursive: true });
mkdirSync(packages, { recursive: true });
const icon = join(webRoot, 'tv-packaging', 'assets', 'icon-80.png');
const largeIcon = join(webRoot, 'tv-packaging', 'assets', 'icon-130.png');
if (!existsSync(icon) || !existsSync(largeIcon))
  throw new Error('TV icons are missing; run node scripts/tv-icons.mjs first');
cpSync(icon, join(shell, 'icon.png'));

if (platform === 'tizen') {
  writeFileSync(
    join(shell, 'README.md'),
    `Tizen packaging is intentionally pending bundled-client validation.\nRemote URL: ${remote.origin}\nBuild the normal web app, then validate asset base paths, SPA routes, media APIs, and Samsung certificate/profile requirements before producing a .wgt.\n`,
  );
  console.error(
    'Tizen bundled packaging is pending validation of the app route/media/API surface; no .wgt was created.',
  );
  process.exitCode = 1;
} else {
  const redirect = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=1920,height=1080,initial-scale=1,viewport-fit=cover"><title>Den</title></head>
<body><p>Opening Den…</p><script>
const target = ${JSON.stringify(remote.href)};
window.addEventListener('keydown', (event) => { if (event.key === 'Escape' || event.key === 'Backspace') history.back(); });
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
else console.log(`Created ${join(packages, `com.den.edge.tv_${version}_all.ipk`)}`);
console.log(`Remote origin configured: ${remote.origin}`);
