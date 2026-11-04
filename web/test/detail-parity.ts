import { mount } from 'svelte';
import { ensureSyncPolicy } from '../src/lib/syncLoader';
import Fixture from './DetailParityFixture.svelte';

async function main() {
  await ensureSyncPolicy();
  const fixturePath = new URL(location.href).searchParams.get('fixturePath');
  if (fixturePath && /^\/(?:movie|tv)\/\d+$/.test(fixturePath))
    history.replaceState(null, '', fixturePath);
  mount(Fixture, { target: document.getElementById('app')! });
}

void main();
