// Putting text on the clipboard from a tap: the call has to start synchronously inside the gesture, since an
// `await` ahead of it (even a resolved one) can spend the gesture before `navigator.clipboard` ever runs on
// Safari — which is why `copyText` must be called directly from a click/tap handler, never from inside
// another `await`. `text` may still be a Promise: `ConnectionsSection`'s pairing code is shown to the guest a
// moment after the tap that starts hosting, and the write has to begin on that tap, not on the later one that
// never comes — den-edge/#65 fixed it by handing `navigator.clipboard.write` a `ClipboardItem` whose data is
// itself a Promise, which Safari accepts from a gesture that already started.
//
// `navigator.clipboard.writeText`/`.write` can still be refused on a real iPhone in cases this codebase has not
// pinned down (and that WebKit's own test build does not reproduce, so no automated test here catches the
// refusal itself) — `document.execCommand('copy')` on a selection is the older, more forgiving API and is tried
// next. If even that is refused, `select` has already put the text up for a long-press copy, which is left in
// place rather than cleared.

export type CopyOutcome = 'copied' | 'manual';

async function writeToClipboard(text: string | Promise<string>): Promise<void> {
  if (typeof ClipboardItem === 'function' && navigator.clipboard?.write) {
    const blob = Promise.resolve(text).then(
      (resolved) => new Blob([resolved], { type: 'text/plain' }),
    );
    await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
    return;
  }
  await navigator.clipboard?.writeText(await text);
}

/**
 * Copy `text` to the clipboard. Returns `'copied'` once it is there (by either path), or `'manual'` when
 * neither worked — `select`, if given, has still put it in the page's selection for a long-press copy.
 *
 * `select` is the one call that knows how to select what's already on screen: `field.select()` for a
 * readonly input, `getSelection()?.selectAllChildren(el)` for plain text. Left out where nothing is shown to
 * select — the clipboard write is still attempted, just with no manual fallback.
 */
export async function copyText(
  text: string | Promise<string>,
  select?: () => void,
): Promise<CopyOutcome> {
  try {
    await writeToClipboard(text);
    return 'copied';
  } catch (error) {
    console.warn('den: clipboard write was refused', error);
  }
  try {
    const resolved = await text;
    select?.();
    if (document.execCommand('copy')) return 'copied';
    console.warn('den: clipboard fallback copy did not take', { length: resolved.length });
  } catch (error) {
    console.warn('den: clipboard fallback copy failed', error);
  }
  return 'manual';
}
