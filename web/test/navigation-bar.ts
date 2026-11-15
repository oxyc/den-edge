import { mount } from 'svelte';
import type { InterfaceLanguage } from '../src/lib/interfaceLanguage';
import { setInterfaceLanguage } from '../src/lib/i18n.svelte';
import Fixture from './NavigationFixture.svelte';
mount(Fixture, { target: document.getElementById('app')! });

// RoutedLibrary publishes a replacement profile's language through this same production authority. Keep this
// fixture seam smaller than a second profile coordinator while exercising the mounted NavigationBar itself.
(
  window as typeof window & {
    denNavigationFixture: {
      replaceProfileLanguage: (language: InterfaceLanguage) => Promise<void>;
    };
  }
).denNavigationFixture = { replaceProfileLanguage: setInterfaceLanguage };
