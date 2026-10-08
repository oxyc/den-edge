import { mount } from 'svelte';
import { ensureSyncPolicy } from '../src/lib/syncLoader';
import Fixture from './DetailParityFixture.svelte';

await ensureSyncPolicy();
mount(Fixture, { target: document.getElementById('app')! });
