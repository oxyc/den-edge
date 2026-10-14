#!/usr/bin/env node
// Repair a profile-aware household that an older browser wrote its pre-split library back into (see
// householdRepair.ts). A dry run unless --apply is given; it prints row names and counts, never values or keys.
//
//   node web/scripts/repair-household.mjs --edge <url> --key-file <path> [--owner-key-file <path>] [--apply]
//
// The key files hold the base64 library keys. The Owner key is read from the household's directory when not given.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runnerImport } from 'vite';

const { values } = parseArgs({
  options: {
    edge: { type: 'string' },
    'key-file': { type: 'string' },
    'owner-key-file': { type: 'string' },
    apply: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  },
});
if (!values.edge || !values['key-file'] || (values.apply && values['dry-run'])) {
  console.error(
    'usage: repair-household.mjs --edge <url> --key-file <path> [--owner-key-file <path>] [--dry-run | --apply]',
  );
  process.exit(2);
}

const web = fileURLToPath(new URL('..', import.meta.url));
const { module } = await runnerImport(
  fileURLToPath(new URL('householdRepair.ts', import.meta.url)),
  {
    root: web,
    configFile: false,
    logLevel: 'error',
  },
);
try {
  const report = await module.repairHousehold({
    edge: values.edge,
    householdKey: readFileSync(values['key-file'], 'utf8'),
    ownerKey: values['owner-key-file'] ? readFileSync(values['owner-key-file'], 'utf8') : undefined,
    apply: values.apply,
    say: (line) => console.log(line),
  });
  console.log(`result: ${JSON.stringify(report)}`);
  // The library logs' runtime channels would keep Node alive after the work is done.
  process.exit(0);
} catch (error) {
  console.error(`repair-household: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
