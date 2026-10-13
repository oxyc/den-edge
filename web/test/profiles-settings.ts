import { mount } from 'svelte';
import ProfilesSettingsFixture from './ProfilesSettingsFixture.svelte';
import '../src/app.css';

mount(ProfilesSettingsFixture, { target: document.getElementById('app')! });
