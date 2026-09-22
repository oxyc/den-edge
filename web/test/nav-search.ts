import { mount } from 'svelte';
import Fixture from './NavSearchFixture.svelte';
// `?at=/search` opens the fixture as if that address had been loaded: a fresh load of a page other than Home.
const at = new URLSearchParams(location.search).get('at');
if (at) history.replaceState(null, '', at);
mount(Fixture, { target: document.getElementById('app')! });
