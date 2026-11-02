import { mount } from 'svelte';
import { ensureDeferredSyncPolicy, ensureSyncPolicy } from '../src/lib/syncLoader';
import Fixture from './LibraryFixture.svelte';

// The policy has to be up before anything reads the log, because `applyLog` asks it what each row means.
// The app gets that for free — `LibraryLog.open()` awaits it, so a log cannot exist before the core does —
// but this fixture hands `Library.svelte` a log it built itself, which skips that door. Its v2 rows become the
// documents the authority reads through `apply_write`, which is the deferred core's.
await ensureSyncPolicy();
await ensureDeferredSyncPolicy();
mount(Fixture, { target: document.getElementById('app')! });
