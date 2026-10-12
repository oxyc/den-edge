import { mount } from 'svelte';
import ProfileModeFixture from './ProfileModeFixture.svelte';
import '../src/app.css';

const target = document.getElementById('app');
if (!target) throw new Error('profile mode fixture has no #app');
mount(ProfileModeFixture, { target });
