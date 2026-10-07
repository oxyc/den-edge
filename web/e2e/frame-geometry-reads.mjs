/** Record layout-sensitive row geometry read from an animation-frame callback. */
export async function recordFrameGeometryReads(page) {
  await page.addInitScript(() => {
    let inAnimationFrame = false;
    let reads = [];
    const requestFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) =>
      requestFrame((time) => {
        inAnimationFrame = true;
        try {
          return callback(time);
        } finally {
          inAnimationFrame = false;
        }
      });

    const intercept = (target, property, relevant = () => true) => {
      let owner = target;
      while (owner && !Object.hasOwn(owner, property)) owner = Object.getPrototypeOf(owner);
      const descriptor = owner && Object.getOwnPropertyDescriptor(owner, property);
      if (!descriptor?.get) throw new Error(`No ${property} getter to instrument`);
      Object.defineProperty(owner, property, {
        ...descriptor,
        get() {
          if (inAnimationFrame && relevant(this)) reads.push(property);
          return descriptor.get.call(this);
        },
      });
    };

    intercept(Element.prototype, 'scrollLeft', (node) => node.classList.contains('track'));
    intercept(window, 'innerWidth');
    window.takeFrameGeometryReads = () => {
      const taken = reads;
      reads = [];
      return taken;
    };
  });
}
