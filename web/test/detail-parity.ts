import { mount } from 'svelte';
import { ensureSyncPolicy } from '../src/lib/syncLoader';
import { isInterfaceLanguage } from '../src/lib/interfaceLanguage';
import { setInterfaceLanguage } from '../src/lib/i18n.svelte';
import Fixture from './DetailParityFixture.svelte';

async function main() {
  await ensureSyncPolicy();
  const params = new URL(location.href).searchParams;
  const language = params.get('language');
  if (isInterfaceLanguage(language)) await setInterfaceLanguage(language);
  const fixturePath = params.get('fixturePath');
  if (fixturePath && /^\/(?:movie|tv)\/\d+$/.test(fixturePath))
    history.replaceState(null, '', fixturePath);
  mount(Fixture, { target: document.getElementById('app')! });
}

void main();
