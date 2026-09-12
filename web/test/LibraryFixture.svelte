<script lang="ts">
  import Library from '../src/Library.svelte';
  import type { LibrarySession } from '../src/lib/librarySession.svelte';
  const log = {
    settings: (group: string) =>
      group === 'keys'
        ? { values: { tmdb: { value: { string: 'fixture-key' }, at: [1, 0, 'test'] } } }
        : undefined,
    refresh: async () => false,
    rows: () => [],
    newestStamp: () => [1, 0, 'test'],
  };
  const session = {
    changed: () => {},
    revision: 0,
    settingsRevision: 0,
    displays: [],
    shapes: new Map(),
    log,
    opened: Promise.resolve(log),
  } as unknown as LibrarySession;
  const link = { inboxKey: 'fixture', libraryKey: 'fixture', linkKey: 'fixture' };
</script>

<Library {link} {session} route={{ page: 'library' }} active={true} />
