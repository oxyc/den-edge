import { mount } from 'svelte';
import Fixture from './WorkerHydrationFixture.svelte';

mount(Fixture, { target: document.getElementById('app')! });
