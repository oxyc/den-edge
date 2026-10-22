// Chromium 47 / Tizen 3 page compatibility. These globals are installed once, before any Svelte screen evaluates,
// so ordinary components keep using the standard browser APIs without target-specific branches or fallbacks.
import './compat-tizen3-worker';
import 'intersection-observer';
import { ResizeObserver as ResizeObserverPolyfill } from '@juggle/resize-observer';

if (!('ResizeObserver' in globalThis)) {
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: ResizeObserverPolyfill,
  });
}

// ChildNode and ParentNode methods arrived in Chromium 54 (`replaceChildren` in 86); Svelte mounts with `before`.
const nodes = (items: (Node | string)[]): Node => {
  const fragment = document.createDocumentFragment();
  for (const item of items)
    fragment.appendChild(typeof item === 'string' ? document.createTextNode(item) : item);
  return fragment;
};
const define = (
  target: object,
  name: string,
  value: (this: Node, ...items: (Node | string)[]) => void,
) => {
  if (!(name in target))
    Object.defineProperty(target, name, { configurable: true, writable: true, value });
};
for (const target of [Element.prototype, CharacterData.prototype, DocumentType.prototype]) {
  define(target, 'before', function (...items) {
    this.parentNode?.insertBefore(nodes(items), this);
  });
  define(target, 'after', function (...items) {
    this.parentNode?.insertBefore(nodes(items), this.nextSibling);
  });
  define(target, 'replaceWith', function (...items) {
    this.parentNode?.replaceChild(nodes(items), this);
  });
}
for (const target of [Element.prototype, Document.prototype, DocumentFragment.prototype]) {
  define(target, 'append', function (...items) {
    this.appendChild(nodes(items));
  });
  define(target, 'prepend', function (...items) {
    this.insertBefore(nodes(items), this.firstChild);
  });
  define(target, 'replaceChildren', function (...items) {
    while (this.firstChild) this.removeChild(this.firstChild);
    this.appendChild(nodes(items));
  });
}
