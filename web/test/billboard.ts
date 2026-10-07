import { mount } from 'svelte';
import { keepPersonalBackdrop, preloadPersonalBackdrop } from '../src/lib/recommend';
import Fixture from './BillboardFixture.svelte';

if (new URLSearchParams(location.search).has('preload')) {
  await keepPersonalBackdrop('fixture-library', null, true, '/early.jpg');
  await preloadPersonalBackdrop('/', 'fixture-library', true, true);
}
mount(Fixture, { target: document.getElementById('app')! });
