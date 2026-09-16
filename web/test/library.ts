import { mount } from 'svelte';
import { ensureSyncPolicy } from '../src/lib/syncLoader';
import Fixture from './LibraryFixture.svelte';

// The policy has to be up before anything reads the log, because `applyLog` asks it what each row means.
// The app gets that for free — `LibraryLog.open()` awaits it, so a log cannot exist before the core does —
// but this fixture hands `Library.svelte` a log it built itself, which skips that door.
await ensureSyncPolicy();
mount(Fixture, { target: document.getElementById('app')! });
