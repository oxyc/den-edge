import { mount } from 'svelte';
import { ensureDeferredSyncPolicy, ensureSyncPolicy } from '../src/lib/syncLoader';
import Fixture from './NavSearchFixture.svelte';
// `?at=/search` opens the fixture as if that address had been loaded: a fresh load of a page other than Home.
const at = new URLSearchParams(location.search).get('at');
if (at) history.replaceState(null, '', at);
// The fixture's log holds its rows as documents in den-core, made through `apply_write` (the deferred core).
await ensureSyncPolicy();
await ensureDeferredSyncPolicy();
mount(Fixture, { target: document.getElementById('app')! });
