const ID = 'den-update-notice';

/** Already loaded with release recovery, so a deploy cannot remove this renderer before an old tab needs it. */
export function showUpdateNotice(reloadPage: () => void): void {
  if (document.getElementById(ID)) return;
  // Popover's browser-owned layer stays on screen without release-specific CSS which a strict CSP could reject.
  // `open` below keeps the same content visible as a non-modal dialog in browsers old enough to lack popovers.
  const notice = document.createElement('dialog');
  notice.id = ID;
  notice.className = 'glass den-button-player';
  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-live', 'polite');
  notice.setAttribute('popover', 'manual');

  const message = document.createElement('span');
  message.textContent = 'Den was updated';
  const reload = document.createElement('button');
  reload.type = 'button';
  reload.className = 'den-button den-button-compact den-button-primary';
  reload.textContent = 'Reload';
  reload.addEventListener('click', () => reloadPage());
  notice.append(message, document.createTextNode(' — '), reload);
  document.body.append(notice);
  try {
    notice.showPopover();
  } catch {
    notice.setAttribute('open', '');
  }
}
