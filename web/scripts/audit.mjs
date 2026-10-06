#!/usr/bin/env node
// Fails CI on any high/critical `npm audit` advisory except an explicit, time-boxed
// allowlist. npm audit has no first-party allowlist, and the `--force` fix available here
// would downgrade stylelint-config-standard to a breaking major just to satisfy the scanner.
import { execFileSync } from 'node:child_process';

// GHSA id -> { reason, expires: "YYYY-MM-DD" }. Every entry needs a reason and an expiry;
// once expired the advisory is treated as un-allowlisted, so it forces a re-review rather
// than staying silenced forever.
const ALLOWLIST = {
  'GHSA-vfj7-8cjw-p6xm': {
    reason:
      'dev-only lint tooling; DoS on attacker-crafted glob patterns, which lint never receives',
    expires: '2026-11-02',
  },
  'GHSA-68fv-2mgg-jv7q': {
    reason:
      'build-time source-map parsing; DoS needs an attacker-crafted source map, which the build never reads; fixed 1.2.2 clears the npm min-release-age on 2026-10-07',
    expires: '2026-10-08',
  },
};

function runAudit() {
  try {
    const out = execFileSync('npm', ['audit', '--audit-level=high', '--json'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 32,
    });
    return JSON.parse(out);
  } catch (err) {
    // npm audit exits non-zero once it finds anything at/above --audit-level; stdout still
    // carries the full JSON report.
    if (err.stdout) return JSON.parse(err.stdout);
    throw err;
  }
}

// Collects the distinct advisories (by GHSA id) anywhere in the dependency graph, regardless
// of which package `npm audit` attributes the top-level entry to.
function advisories(report) {
  const found = new Map(); // GHSA id -> { severity, title, packages: Set<string> }
  for (const [pkg, vuln] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of vuln.via ?? []) {
      if (typeof via !== 'object' || !via.url) continue;
      const match = /GHSA-[a-z0-9]+-[a-z0-9]+-[a-z0-9]+/.exec(via.url);
      const id = match ? match[0] : via.url;
      if (!found.has(id)) {
        found.set(id, { severity: via.severity, title: via.title, packages: new Set() });
      }
      found.get(id).packages.add(pkg);
    }
  }
  return found;
}

const report = runAudit();
const found = advisories(report);
const today = new Date().toISOString().slice(0, 10);
let failed = false;

for (const [id, info] of found) {
  if (info.severity !== 'high' && info.severity !== 'critical') continue;

  const allowed = ALLOWLIST[id];
  if (!allowed) {
    console.error(`audit: ${id} (${info.severity}) is not allowlisted — ${info.title}`);
    console.error(`  affects: ${[...info.packages].join(', ')}`);
    failed = true;
    continue;
  }
  if (allowed.expires < today) {
    console.error(
      `audit: ${id} allowlist entry expired ${allowed.expires} — re-review and renew or fix it`,
    );
    failed = true;
    continue;
  }
  console.log(
    `audit: ${id} (${info.severity}) allowlisted until ${allowed.expires} — ${allowed.reason}`,
  );
}

if (failed) {
  process.exit(1);
}

console.log('audit: no high/critical advisories outside the allowlist');
