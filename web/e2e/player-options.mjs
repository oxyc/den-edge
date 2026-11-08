// The browser player's settings: one ⋯ button whose menu opens with what is playing, each row naming its current value
// and opening a page of its own (Audio & subtitles, Stream, Source, Subtitle timing); and the dock's Audio & subtitles
// button, which opens straight to that page.
import { expect } from '@playwright/test';

export const optionsButton = (page) => page.getByRole('button', { name: 'More playback options' });
export const optionsMenu = (page) => page.getByRole('menu', { name: 'More playback options' });

/**
 * The controls brought back as a viewer does once they have hidden while playing: a mouse moving over the picture, a
 * finger tapping it between the toast lane at the top and the transport at its centre.
 */
export async function revealControls(page, { tap = false } = {}) {
  const player = page.locator('.player');
  if (!/web-controls-hidden/.test((await player.getAttribute('class')) ?? '')) return;
  const box = await page.locator('.player video').boundingBox();
  if (!box) return;
  if (tap) await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height * 0.38);
  else await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 1);
  await expect(player).not.toHaveClass(/web-controls-hidden/);
}

/** The options opened at one row's page ("Stream", "Source", "Subtitle timing", "Audio & subtitles"). */
export async function openOptionsPage(page, row, { tap = false } = {}) {
  await revealControls(page, { tap });
  const button = optionsButton(page);
  await (tap ? button.tap() : button.click());
  const menu = optionsMenu(page);
  const item = menu.getByRole('menuitem', { name: new RegExp(`^${escape(row)}(,|$)`) });
  await (tap ? item.tap() : item.click());
  return menu;
}

/** The dock's Audio & subtitles button: its name ends with the subtitle showing ("…, subtitles English"). */
export const subtitlesButton = (page) => page.locator('button.web-audio-subtitles');

export const showsSubtitles = (page, name, options) =>
  expect(subtitlesButton(page)).toHaveAccessibleName(
    new RegExp(`subtitles ${escape(name)}$`),
    options,
  );

/** A subtitle among the open Audio & subtitles page's choices, apart from the audio tracks above them. */
export const subtitleChoice = (page, name, options = {}) =>
  page.getByRole('group', { name: 'Subtitles' }).getByRole('menuitemradio', { name, ...options });

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
