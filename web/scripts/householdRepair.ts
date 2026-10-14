// A one-off, key-holding repair of a profile-aware household (wire 5, with a `profiles` directory) that an older
// browser wrote its pre-split library back into. The Owner-only rows it wrote (titles, seasons, receipts, trackers,
// the Owner's preferences and Simkl key) are first merged into the Owner's library where that changes anything, then
// a fenced rewrite of the household keeps every other row and cuts `set:prefs` and `set:keys` to their household
// halves. den-core's profile split (`profiles_migration_partition_rows`) decides which rows and keys are the Owner's.
// Run it through `repair-household.mjs`; it writes nothing unless asked to.

import { readFileSync } from 'node:fs';
import { initialize } from '../src/vendor/den-core/index.js';
import { LibraryLog } from '../src/lib/log';
import {
  profileMigrationMaterialize,
  profileMigrationPartition,
  type AuthenticatedMigrationRow,
  type MigrationPartition,
  type MigrationProjection,
} from '../src/lib/profileMigrationCore';
import { syncPolicy } from '../src/lib/syncCore';
import {
  deriveKeys,
  fromBase64url,
  mergeSettings,
  openMigrationRow,
  sealPlaintext,
  type DocumentRow,
  type LibraryKeys,
  type MigrationOpenedRow,
  type SettingsRow,
} from '../src/lib/wire';

export interface RepairOptions {
  /** den-edge's origin, e.g. `http://127.0.0.1:8094`. */
  edge: string;
  householdKey: string;
  /** Optional: it must match the directory's Owner library when given. */
  ownerKey?: string;
  apply: boolean;
  say?: (line: string) => void;
}

export interface RepairReport {
  /** Names of the Owner-only rows found, grouped by kind (`title:`, `set:trackers`, …), with counts. */
  ownerRows: Record<string, number>;
  /** Owner-only keys found in rows the household keeps a half of (`set:prefs`, `set:keys`): key names only. */
  ownerKeys: Record<string, string[]>;
  /** Writes the Owner's library needed (documents and settings) before anything leaves the household. */
  ownerWrites: number;
  before: { rows: number; ownerRows: number };
  after: { rows: number; ownerRows: number } | null;
  outcome: 'clean' | 'dry-run' | 'repaired';
}

let core: Promise<void> | undefined;

/** Node has no HTTP origin for the WASM, so it is read from the vendored file. */
export function initializeCore(): Promise<void> {
  return (core ??= initialize(
    readFileSync(new URL('../src/vendor/den-core/generated/den_core_bg.wasm', import.meta.url)),
  ));
}

const keyBytes = (key: string) => Uint8Array.from(atob(key.trim()), (c) => c.charCodeAt(0));

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** The directory row and Kid approvals: household control state, never part of the split. */
function control(opened: MigrationOpenedRow): boolean {
  const name = opened.name ?? '';
  if (name === 'profiles' || name.startsWith('kid-title-approvals:')) return true;
  const body =
    opened.status === 'row' ? opened.row : opened.status === 'document' ? opened.document : null;
  return body?.kind === 'profiles' || body?.kind === 'kid-title-approvals';
}

interface Classified {
  partition: MigrationPartition;
  /** Directory and approvals rows, kept exactly as stored. */
  control: { k: string; v: string }[];
  rows: number;
}

/**
 * Every stored row opened under the household key and split by den-core, the control rows set aside. This is the one
 * place the repair decides what is the Owner's: it uses the split's own partition (`owner` leaves, `household` is
 * kept, `set:prefs` and `set:keys` cut to their household halves) until den-core's `profile_household_audit` is
 * vendored here, which answers the same question for a household that already has profiles.
 */
async function classify(
  keys: LibraryKeys,
  base: number,
  stored: readonly { k: string; v: string; seq: number }[],
): Promise<Classified> {
  const kept: { k: string; v: string }[] = [];
  const rows: AuthenticatedMigrationRow[] = [];
  for (const row of stored) {
    if (row.seq > base) continue;
    const opened = await openMigrationRow(keys, row.k, row.v);
    if (control(opened)) kept.push({ k: row.k, v: row.v });
    else rows.push({ k: row.k, v: row.v, seq: row.seq, opened });
  }
  const partition = profileMigrationPartition({
    base,
    ownerPolicyAt: [0, 0, '0000000000000000'],
    rows,
  });
  return { partition, control: kept, rows: rows.length + kept.length };
}

function nameOf(projection: MigrationProjection): string {
  if (projection.mode !== 'materialize')
    throw new Error('den-core kept household ciphertext for the Owner');
  return projection.name;
}

function kindOf(name: string): string {
  if (/^(title|season|dlv):/.test(name)) return name.slice(0, name.indexOf(':') + 1);
  if (/^set:(deliver|handoff):/.test(name)) return name.split(':').slice(0, 2).join(':') + ':*';
  return name;
}

function summarize(partition: MigrationPartition) {
  const ownerRows: Record<string, number> = {};
  const ownerKeys: Record<string, string[]> = {};
  for (const projection of partition.owner) {
    const name = nameOf(projection);
    const kind = kindOf(name);
    ownerRows[kind] = (ownerRows[kind] ?? 0) + 1;
    const row = (projection as { row: SettingsRow }).row;
    if (name === 'set:prefs' || name === 'set:keys')
      ownerKeys[name] = Object.keys(row.values ?? {}).sort();
  }
  return { ownerRows, ownerKeys };
}

interface OwnerWrite {
  name: string;
  row: DocumentRow | SettingsRow;
  base: number;
}

/**
 * What the Owner's library needs so it holds everything the household is about to lose: den-core's v4 write-back
 * for the documents (the household's copy as held, the Owner's log as the log), and the settings merge for each
 * settings row. Empty when the Owner already has all of it.
 */
async function ownerPlan(
  owner: LibraryLog,
  keys: LibraryKeys,
  leaving: MigrationPartition['owner'],
) {
  const snapshot = await owner.resetSnapshot();
  if (snapshot === null || typeof snapshot === 'string')
    throw new Error(`The Owner's library could not be read (${snapshot ?? 'unreachable'})`);
  const documents = new Map<string, { seq: number; document: DocumentRow }>();
  const settings = new Map<string, { seq: number; row: SettingsRow }>();
  for (const { k, v, seq } of snapshot.rows) {
    const opened = await openMigrationRow(keys, k, v);
    if (opened.status === 'document')
      documents.set(opened.name, { seq, document: opened.document });
    else if (opened.status === 'row' && opened.name?.startsWith('set:'))
      settings.set(opened.name, { seq, row: opened.row as SettingsRow });
  }
  const writes: OwnerWrite[] = [];
  const held: DocumentRow[] = [];
  for (const projection of leaving) {
    const name = nameOf(projection);
    const row = (projection as { row: DocumentRow | SettingsRow }).row;
    if (row.kind !== 'set') {
      held.push(row as DocumentRow);
      continue;
    }
    const theirs = settings.get(name);
    const merged = theirs ? mergeSettings(theirs.row, row as SettingsRow) : (row as SettingsRow);
    if (!theirs || canonical(merged) !== canonical(theirs.row))
      writes.push({ name, row: merged, base: theirs?.seq ?? 0 });
  }
  const back = syncPolicy<{
    writes: { name: string; document: DocumentRow }[];
    dropped: unknown[];
    discarded: number;
  }>({
    op: 'write_back_v4',
    documents: held,
    log: [...documents.values()].map(({ document }) => document),
    now: Date.now(),
  });
  if (back.dropped.length || back.discarded)
    throw new Error(
      `den-core would not merge every Owner document (${JSON.stringify(back.dropped)}, ${back.discarded} discarded)`,
    );
  for (const { name, document } of back.writes)
    writes.push({ name, row: document, base: documents.get(name)?.seq ?? 0 });
  return writes;
}

async function sealProjection(keys: LibraryKeys, projection: MigrationProjection) {
  if (projection.mode === 'preserve') return { k: projection.k, v: projection.v };
  const { plaintext } = profileMigrationMaterialize({ name: projection.name, row: projection.row });
  return sealPlaintext(keys, projection.name, fromBase64url(plaintext));
}

export async function repairHousehold(options: RepairOptions): Promise<RepairReport> {
  const say = options.say ?? (() => {});
  await initializeCore();
  const fetchImpl = ((input: string, init?: RequestInit) =>
    fetch(options.edge.replace(/\/$/, '') + input, init)) as typeof fetch;
  const householdKeys = await deriveKeys(keyBytes(options.householdKey));
  const household = await LibraryLog.forReset(options.householdKey, 5, fetchImpl, undefined, null);
  const read = async () => {
    const snapshot = await household.resetSnapshot();
    if (snapshot === null || typeof snapshot === 'string')
      throw new Error(`The household could not be read (${snapshot ?? 'unreachable'})`);
    return snapshot;
  };

  const snapshot = await read();
  if (!snapshot.directory)
    throw new Error(
      'The household has no profiles directory: its Owner rows are its own, there is nothing to repair',
    );
  if (household.wireMinimum < 5)
    throw new Error(`The household is at wire minimum ${household.wireMinimum}, not 5`);
  const ownerEntry = snapshot.directory.profiles[snapshot.directory.owner];
  const ownerKey = ownerEntry?.library.value.key;
  if (!ownerKey) throw new Error('The directory names no Owner library');
  if (options.ownerKey && options.ownerKey.trim() !== ownerKey)
    throw new Error("The Owner key given is not the directory's Owner library");

  const before = await classify(householdKeys, snapshot.base, snapshot.rows);
  const { ownerRows, ownerKeys } = summarize(before.partition);
  say(`household: ${before.rows} rows, ${before.partition.owner.length} Owner-only`);
  for (const [kind, count] of Object.entries(ownerRows)) say(`  Owner-only ${kind}: ${count}`);
  for (const [name, keys] of Object.entries(ownerKeys))
    say(`  Owner-only keys in ${name}: ${keys.join(', ')}`);

  const report: RepairReport = {
    ownerRows,
    ownerKeys,
    ownerWrites: 0,
    before: { rows: before.rows, ownerRows: before.partition.owner.length },
    after: null,
    outcome: 'clean',
  };
  if (!before.partition.owner.length) {
    say('nothing to repair');
    return report;
  }

  const ownerLibraryKeys = await deriveKeys(keyBytes(ownerKey));
  const owner = await LibraryLog.forReset(ownerKey, 4, fetchImpl, undefined, null);
  const plan = await ownerPlan(owner, ownerLibraryKeys, before.partition.owner);
  report.ownerWrites = plan.length;
  say(
    `Owner library: ${plan.length} writes needed${plan.length ? `: ${plan.map((w) => kindOf(w.name)).join(', ')}` : ''}`,
  );
  if (!options.apply) {
    say('dry run: nothing written (pass --apply to repair)');
    report.outcome = 'dry-run';
    return report;
  }

  for (const write of plan)
    if (!(await owner.writeAt(write.row, write.base)))
      throw new Error(`The Owner's ${write.name} could not be written; nothing left the household`);
  if ((await ownerPlan(owner, ownerLibraryKeys, before.partition.owner)).length)
    throw new Error(
      "The Owner's library still lacks a row after the write-back; nothing left the household",
    );
  if (plan.length) say(`Owner library: ${plan.length} rows merged in`);

  const secured = canonical(
    before.partition.owner.map((p) => [nameOf(p), (p as { row: unknown }).row]),
  );
  let refusal: string | null = null;
  let staged: string[] = [];
  const committed = await household.rewriteStored(async (base, raw) => {
    const fenced = await classify(householdKeys, base, raw);
    if (
      canonical(fenced.partition.owner.map((p) => [nameOf(p), (p as { row: unknown }).row])) !==
      secured
    ) {
      refusal = 'the household changed since the Owner was secured; run it again';
      return null;
    }
    const writes = [
      ...fenced.control,
      ...(await Promise.all(
        fenced.partition.household.map((p) => sealProjection(householdKeys, p)),
      )),
    ];
    const accounted = fenced.control.length + fenced.partition.accounting.length;
    if (accounted !== raw.length) {
      refusal = `${raw.length - accounted} rows were not accounted for`;
      return null;
    }
    staged = writes.map(({ k }) => k).sort();
    return { writes, wireMin: Math.max(5, household.wireMinimum) };
  });
  if (!committed)
    throw new Error(`The household rewrite did not commit${refusal ? `: ${refusal}` : ''}`);

  const after = await read();
  const checked = await classify(householdKeys, after.base, after.rows);
  report.after = { rows: checked.rows, ownerRows: checked.partition.owner.length };
  say(`household after: ${checked.rows} rows, ${checked.partition.owner.length} Owner-only`);
  if (checked.partition.owner.length) throw new Error('Owner-only rows remain in the household');
  if (!after.directory) throw new Error('The profiles directory is gone after the rewrite');
  if (checked.control.length !== before.control.length)
    throw new Error('A directory or Kid approvals row changed in the rewrite');
  if (canonical(after.rows.map(({ k }) => k).sort()) !== canonical(staged))
    throw new Error('The household does not hold exactly the rows the rewrite staged');
  report.outcome = 'repaired';
  return report;
}
