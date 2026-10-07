import { mount } from 'svelte';
import {
  BILLBOARD_IMAGE_SIZES,
  billboardBackdropSrcset,
  keepPersonalBackdrop,
  preloadPersonalBackdrop,
} from '../src/lib/recommend';
import Fixture from './BillboardFixture.svelte';

if (new URLSearchParams(location.search).has('preload')) {
  const path = '/early.jpg';
  await keepPersonalBackdrop('fixture-library', null, true, '/early.jpg');
  const url = await preloadPersonalBackdrop('/', 'fixture-library', true, true);
  const shell = document.querySelector<HTMLElement>('[data-den-early-billboard]');
  const image = shell?.querySelector<HTMLImageElement>('[data-den-early-backdrop]');
  if (shell && image && url) {
    image.dataset.path = path;
    image.dataset.fixtureShellNode = 'true';
    image.fetchPriority = 'high';
    image.sizes = BILLBOARD_IMAGE_SIZES;
    image.srcset = billboardBackdropSrcset(path);
    image.src = url;
    shell.hidden = false;
  }
}
mount(Fixture, { target: document.getElementById('app')! });
