/**
 * Let modified clicks keep the browser's native link behaviour, while an ordinary activation uses the already
 * mounted in-app surface. Enter dispatches the same unmodified click, so keyboard and pointer follow one path.
 */
export function activateLinkInPlace(event: MouseEvent, activate: () => void): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    return;
  event.preventDefault();
  activate();
}
