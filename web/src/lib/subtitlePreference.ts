import { syncPolicy } from './syncCore';
import type { ConfigValue, SettingsRow } from './wire';

export type SubtitlePreference =
  | { readonly mode: 'automatic' }
  | { readonly mode: 'off' }
  | { readonly mode: 'language'; readonly language: string };

interface ReadAnswer {
  readonly version: 1;
  readonly choice: SubtitlePreference;
}

interface WriteAnswer {
  readonly version: 1;
  readonly changes: Record<string, ConfigValue | null>;
}

const KEYS = ['den.preferredSubtitleLanguage', 'den.hasExplicitSubtitlePreference'] as const;

/** Read the three-state preference. Stored pairs go through den-core; a malformed pair fails closed to explicit Off. */
export function readSubtitlePreference(row: SettingsRow | undefined): SubtitlePreference {
  // Absence is the canonical Automatic state. Answer it without the deferred policy module so a cold Settings
  // surface cannot briefly mistake "den-core is still loading" for the fail-closed explicit-Off state below.
  if (!row || !KEYS.some((key) => Object.hasOwn(row.values, key))) return { mode: 'automatic' };
  const values: Record<string, ConfigValue | null> = {};
  for (const key of KEYS) {
    if (row && Object.hasOwn(row.values, key)) values[key] = row.values[key]?.value ?? null;
  }
  try {
    return syncPolicy<ReadAnswer>({
      op: 'preferences_subtitle_v1',
      operation: 'read',
      values,
    }).choice;
  } catch {
    return { mode: 'off' };
  }
}

/** Both returned members must be stamped in one `set:prefs` edit. */
export function writeSubtitlePreference(
  choice: SubtitlePreference,
): Record<string, ConfigValue | null> {
  return syncPolicy<WriteAnswer>({
    op: 'preferences_subtitle_v1',
    operation: 'write',
    choice,
  }).changes;
}
