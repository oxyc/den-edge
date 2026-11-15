import { mount } from 'svelte';
import Fixture from './ConnectAssistantRecoveryFixture.svelte';

// Load the fixture module from /test, then give the production component its real route contract.
history.replaceState(history.state, '', `/connect${location.search}`);
mount(Fixture, { target: document.getElementById('app')! });
