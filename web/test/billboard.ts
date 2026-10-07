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
    const copy = shell.querySelector<HTMLElement>('[data-den-early-copy]');
    if (copy) {
      copy.querySelector('[data-den-early-title]')!.textContent = 'A short title';
      copy.querySelector('[data-den-early-reason]')!.textContent = 'Fits your viewing taste';
      copy.querySelector<HTMLElement>('[data-den-early-reason]')!.hidden = false;
      copy.querySelector('[data-den-early-facts]')!.textContent = '2026';
      copy.dataset.path = path;
      copy.dataset.detail = 'false';
      copy.hidden = false;
    }
    shell.hidden = false;
  }
}
if (new URLSearchParams(location.search).has('wait-for-mount')) {
  await new Promise<void>((resolve) =>
    window.addEventListener('fixture:mount', () => resolve(), { once: true }),
  );
}
mount(Fixture, { target: document.getElementById('app')! });
