import { mount } from 'svelte';
import { isInterfaceLanguage } from '../src/lib/interfaceLanguage';
import { setInterfaceLanguage } from '../src/lib/i18n.svelte';
import Fixture from './RelatedTitlesFixture.svelte';

async function main() {
  const language = new URL(location.href).searchParams.get('language');
  if (isInterfaceLanguage(language)) await setInterfaceLanguage(language);
  mount(Fixture, { target: document.getElementById('app')! });
  // A profile's language changes live, with the cards already mounted.
  Object.assign(globalThis, { fixtureSetLanguage: setInterfaceLanguage });
}

void main();
