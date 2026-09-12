/** Keep browser toolbar/keyboard height changes from resizing a touch viewport's hero mid-scroll. */
export function stableViewportHeight(node: HTMLElement) {
  const previous = node.style.getPropertyValue('--stable-hero-height');
  let width = window.innerWidth;
  const touchViewport = matchMedia('(pointer: coarse)');
  const measure = () => {
    node.style.removeProperty('--stable-hero-height');
    const height = getComputedStyle(node).minHeight;
    node.style.setProperty('--stable-hero-height', height);
  };
  const resized = () => {
    // Rotation and split-view change width. Height-only changes on touch browsers are usually
    // browser chrome or a keyboard; preserving the measured value also preserves page scroll.
    if (touchViewport.matches && window.innerWidth === width) return;
    width = window.innerWidth;
    measure();
  };
  measure();
  window.addEventListener('resize', resized);
  return {
    destroy() {
      window.removeEventListener('resize', resized);
      if (previous) node.style.setProperty('--stable-hero-height', previous);
      else node.style.removeProperty('--stable-hero-height');
    },
  };
}
