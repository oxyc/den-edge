// Test-only enforcement for the Chromium 47 package. Imported before application code in the page and every owned
// Worker so a modern Playwright engine cannot conceal a dependency on APIs the 2017 TV lacks.
for (const name of ['Proxy', 'BigInt', 'WebAssembly']) Reflect.deleteProperty(globalThis, name);
Object.defineProperty(globalThis, '__denOldEngineLimits', {
  value: {
    proxy: typeof globalThis.Proxy,
    bigint: typeof globalThis.BigInt,
    wasm: typeof globalThis.WebAssembly,
  },
});

// Svelte emits Proxy constructors even where a component only consumes the target's initial shape.
// This supplies no traps: the journeys still catch code that relies on Proxy semantics, while inert
// constructors can run under Chromium 47.
const PassthroughProxy = function <T extends object>(target: T): T {
  return target;
};
PassthroughProxy.revocable = <T extends object>(target: T) => ({
  proxy: target,
  revoke() {},
});
Object.defineProperty(globalThis, 'Proxy', { value: PassthroughProxy, configurable: true });
