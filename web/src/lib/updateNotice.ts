const ID = 'den-update-notice';
// The in-page player and the stand-in shown while its chunk loads. A bar must never sit on the picture.
const PLAYBACK = '.player, .player-screen';

let dismissed = false;
let watching = false;

/**
 * A slim bar across the top of the page, drawn only while no player is open and drawn again when it closes.
 * Already loaded with release recovery, so a deploy cannot remove this renderer before an old tab needs it. Every
 * style is set through the CSSOM: the class names below are the ones the old tab's own stylesheet already has, and
 * a rule written for this release would not be in it.
 */
export function showUpdateNotice(reloadPage: () => void): void {
  if (dismissed || watching) return;
  watching = true;
  // Popover's browser-owned layer stays on screen without release-specific CSS which a strict CSP could reject.
  // `open` below keeps the same content visible as a non-modal dialog in browsers old enough to lack popovers.
  const notice = document.createElement('dialog');
  notice.id = ID;
  notice.setAttribute('role', 'status');
  notice.setAttribute('popover', 'manual');
  Object.assign(notice.style, {
    position: 'fixed',
    inset: '0 0 auto 0',
    margin: '0',
    width: '100%',
    maxWidth: 'none',
    border: '0',
    borderBottom: '1px solid var(--line)',
    padding:
      'max(6px, env(safe-area-inset-top)) max(var(--gutter), env(safe-area-inset-right)) 6px max(var(--gutter), env(safe-area-inset-left))',
    background: 'var(--card)',
    color: 'var(--fg)',
    alignItems: 'center',
    gap: '8px',
    fontSize: '14px',
  });

  const message = document.createElement('span');
  message.textContent = 'A new version of Den is ready.';
  Object.assign(message.style, { flex: '1', minWidth: '0' });
  const reload = document.createElement('button');
  reload.type = 'button';
  reload.className = 'den-button den-button-compact den-button-primary';
  reload.textContent = 'Reload';
  reload.addEventListener('click', () => reloadPage());
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'den-button den-button-compact den-button-icon den-button-tertiary';
  dismiss.setAttribute('aria-label', 'Dismiss');
  dismiss.textContent = '×';
  notice.append(message, reload, dismiss);
  document.body.append(notice);

  let shown = false;
  const sync = () => {
    const wanted = document.querySelector(PLAYBACK) === null;
    if (wanted === shown) return;
    shown = wanted;
    if (shown) {
      notice.style.display = 'flex';
      try {
        notice.showPopover();
      } catch {
        notice.setAttribute('open', '');
      }
    } else {
      notice.style.display = '';
      try {
        notice.hidePopover();
      } catch {
        notice.removeAttribute('open');
      }
    }
  };
  // A player opening or closing is a node added or removed, the one signal every host of it gives.
  const observer = new MutationObserver(sync);
  observer.observe(document.body, { childList: true, subtree: true });
  dismiss.addEventListener('click', () => {
    dismissed = true;
    observer.disconnect();
    notice.remove();
  });
  sync();
}
