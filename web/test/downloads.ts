import { mount } from 'svelte';
import { setInterfaceLanguage } from '../src/lib/i18n.svelte';
import { isInterfaceLanguage } from '../src/lib/interfaceLanguage';
import { ensureSyncPolicy } from '../src/lib/syncLoader';
import Fixture from './DownloadsFixture.svelte';

// The rows are den-core's to read and merge, so the policy is up before the fixture mounts (as `library.ts`).
await ensureSyncPolicy();
const language = new URL(location.href).searchParams.get('language');
if (isInterfaceLanguage(language)) await setInterfaceLanguage(language);
mount(Fixture, { target: document.getElementById('app')! });
