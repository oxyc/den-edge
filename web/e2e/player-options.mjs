// The browser player's settings: one ⋯ button whose menu opens with what is playing, each row naming its current value
// and opening a page of its own (Audio & subtitles, Stream, Source, Subtitle timing); and the dock's Audio & subtitles
// button, which opens straight to that page.
import { expect } from '@playwright/test';

const OPTIONS_NAME =
  /^(?:More playback options|Más opciones de reproducción|Fler uppspelningsalternativ)$/;

export const optionsButton = (page) => page.getByRole('button', { name: OPTIONS_NAME });
export const optionsMenu = (page) => page.getByRole('menu', { name: OPTIONS_NAME });

const centreOwner = async (locator) =>
  locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return {
      control: target === element || element.contains(target),
      video: target instanceof HTMLVideoElement && target.closest('.player') !== null,
    };
  });

const ownsCentre = async (locator) => (await centreOwner(locator)).control;

const armPointerReceipt = (locator) =>
  locator.evaluate((element) => {
    const attempt = ((element.__denOptionsPointerAttempt ?? 0) + 1) % Number.MAX_SAFE_INTEGER;
    element.__denOptionsPointerAttempt = attempt;
    element.__denOptionsPointerReceived = 0;
    element.addEventListener(
      'pointerdown',
      () => {
        if (element.__denOptionsPointerAttempt === attempt)
          element.__denOptionsPointerReceived = attempt;
      },
      { once: true },
    );
    return attempt;
  });

const receivedPointer = (locator, attempt) =>
  locator.evaluate(
    (element, expected) => element.__denOptionsPointerReceived === expected,
    attempt,
  );

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

/** Tap one visible phone control, retrying only when its stale hide deadline won before pointerdown. */
export async function tapPhoneControl(
  page,
  button,
  { tap = (timeout) => button.tap(timeout === undefined ? undefined : { timeout }) } = {},
) {
  if (!(await ownsCentre(button))) await revealControls(page, { tap: true });
  await expect.poll(() => ownsCentre(button)).toBe(true);
  const attempt = await armPointerReceipt(button);
  try {
    await tap(4_000);
  } catch (error) {
    const hidden = /web-controls-hidden/.test(
      (await page.locator('.player').getAttribute('class')) ?? '',
    );
    const [received, owner] = await Promise.all([
      receivedPointer(button, attempt),
      centreOwner(button),
    ]);
    // Hidden controls intentionally give the video their pointer ownership. Retry only when that deadline won
    // before this attempt reached the custom button; a pointer received by it makes any failure the real result.
    if (received || !hidden || !owner.video || owner.control) throw error;
    await revealControls(page, { tap: true });
    await expect.poll(() => ownsCentre(button)).toBe(true);
    await tap();
  }
}

/**
 * Click one visible desktop control as a viewer does: the mouse moves onto it first. Playing, the controls hide 2.5 s
 * after the mouse last moved, and a click that started on a stale "visible" reading found the video owning the
 * button's centre; Playwright's click only re-tests the hit target and never moves the pointer, so nothing brought the
 * controls back and it waited out its whole timeout. Moving there reveals hidden controls (`onpointermove`), and a
 * mouse resting over the top bar or the dock holds them (`webControlsMayHide`), so the click lands on the button.
 */
export async function clickPlayerControl(page, button) {
  const box = await button.boundingBox();
  if (!box) throw new Error('player control has no box to point at');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y - 1);
  await expect(page.locator('.player')).not.toHaveClass(/web-controls-hidden/);
  // A second move after the reveal, so the bar drawn under the resting pointer is the one `:hover` reports.
  await page.mouse.move(x, y);
  await expect.poll(() => ownsCentre(button)).toBe(true);
  await button.click();
}

/** The options opened at one row's page ("Stream", "Source", "Subtitle timing", "Audio & subtitles"). */
export async function openOptionsPage(page, row, { tap = false } = {}) {
  await revealControls(page, { tap });
  const button = optionsButton(page);
  if (tap) {
    // A playing phone hides its controls three seconds after they were last revealed. Runner load can consume the
    // remainder of an already-armed deadline between revealControls' class snapshot and Playwright beginning this
    // tap. Keep the real hit test: if that deadline won, reveal as a viewer does and require the button to own its
    // visible centre before trying once more. Never force the event through the video that correctly owns it hidden.
    await tapPhoneControl(page, button);
  } else await clickPlayerControl(page, button);
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
