// TEMPORARY diagnostics for #1376 (removed before the PR is finished).
import { writeFile } from 'node:fs/promises';
export async function captureDiagnostics(page, info) {
  const log = [];
  const t0 = Date.now();
  const stamp = (kind, text) => log.push(`${String(Date.now() - t0).padStart(6)} ${kind} ${text}`);
  page.on('console', (m) => stamp('console.' + m.type(), m.text()));
  page.on('pageerror', (e) => stamp('pageerror', e.message));
  page.on('requestfailed', (r) => stamp('requestfailed', `${r.url()} ${r.failure()?.errorText}`));
  page.on('request', (r) => stamp('request', r.url()));
  page.on('response', (r) => stamp('response', `${r.status()} ${r.url()}`));
  page.on('framenavigated', (f) => stamp('navigated', f.url()));
  await page.addInitScript(() => {
    const desc = (el) =>
      el
        ? `${el.tagName}.${String(el.className).slice(0, 40)}[${el.getAttribute?.('aria-label') ?? el.textContent?.trim().slice(0, 20)}]`
        : 'null';
    const emit = (text) => console.log('DIAG ' + text);
    const origFocus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (...args) {
      emit(
        `focus() ${desc(this)} path=${location.pathname} stack=${new Error().stack.split('\n').slice(2, 5).join(' | ')}`,
      );
      return origFocus.apply(this, args);
    };
    const origBlur = HTMLElement.prototype.blur;
    HTMLElement.prototype.blur = function (...args) {
      emit(
        `blur() ${desc(this)} stack=${new Error().stack.split('\n').slice(2, 5).join(' | ')}`,
      );
      return origBlur.apply(this, args);
    };
    document.addEventListener('focusin', (e) => emit(`focusin ${desc(e.target)} path=${location.pathname}`), true);
    document.addEventListener('focusout', (e) => emit(`focusout ${desc(e.target)} path=${location.pathname}`), true);
    document.addEventListener(
      'keydown',
      (e) => emit(`keydown ${e.key} active=${desc(document.activeElement)}`),
      true,
    );
  });
  return async (extra = '') => {
    const snapshot = await page
      .evaluate(() => ({
        path: location.pathname,
        active: document.activeElement?.outerHTML.slice(0, 200),
        pages: [...document.querySelectorAll('[data-route-page]')].map(
          (p) => `${p.getAttribute('data-route-page')} active=${p.getAttribute('data-active')}`,
        ),
        billboard: document
          .querySelector('[data-route-page][data-active="true"] .billboard')
          ?.outerHTML.slice(0, 1500),
      }))
      .catch((e) => String(e));
    await writeFile(
      info.outputPath('diag-1376.txt'),
      log.join('\n') + '\nEND ' + extra + '\n' + JSON.stringify(snapshot, null, 1),
    );
  };
}
