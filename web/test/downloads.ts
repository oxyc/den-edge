import { mount } from 'svelte';
import { ensureSyncPolicy } from '../src/lib/syncLoader';
import Fixture from './DownloadsFixture.svelte';

// The rows are den-core's to read and merge, so the policy is up before the fixture mounts (as `library.ts`).
await ensureSyncPolicy();
mount(Fixture, { target: document.getElementById('app')! });
