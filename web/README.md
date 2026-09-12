# Den web

Svelte 5 and TypeScript, built with Vite and served by den-edge. Use Node 24, as CI does.

```sh
npm ci --ignore-scripts
npm run dev
```

Vite proxies the API to the homelab den-edge. Set `DEN_EDGE=http://localhost:8080` to use a local instance.

## Formatting and checks

```sh
npm run format        # Prettier: source, components, styles, tests, scripts, and docs
npm run lint          # Check formatting, ESLint, CSS, Svelte, and TypeScript; does not modify files
npm test              # Unit tests
npm run test:e2e      # Playwright navigation, gestures, layout, and media regression tests
npm run build         # Production bundle and precompressed assets
```

`npm run format:check`, `npm run lint:js`, and `npm run lint:css` can also run independently. CI runs the lint command before tests and the production build. Prettier's Svelte plugin formats component markup, scripts, and styles together. ESLint checks JavaScript, TypeScript, Svelte components, and the tests, using the recommended language and Svelte rules. Formatting rules are left to Prettier so the tools agree. Vendored source, generated WASM bindings, build output, and test artifacts are excluded from formatting.

See [the browser test guide](e2e/README.md) for Playwright setup and [detail parity coverage](test/DETAIL_PARITY.md) for screen behavior.

## CSS conventions

- Keep component styles in the component's `<style>` block. Reserve `src/app.css` for shared tokens, page defaults, and common chrome such as glass surfaces.
- Use the existing color, spacing, and surface custom properties before adding a new shared token. Name classes, custom properties, and animations in kebab-case.
- Put base styles before their states and responsive overrides. Group related selectors and consolidate duplicate rules instead of appending competing overrides. Keep selectors shallow; avoid `!important`.
- Preserve explicit WebKit fallbacks for line clamping, glass, and touch selection. Stylelint's narrow exceptions document the intentional browser compatibility rules; they are not generated prefixes to remove.
- Keep reduced-motion behavior and stable media dimensions. A styling change must preserve retained route layouts, scroll restoration, and snapshot transitions.
- Explain any local Stylelint suppression with a reason. Unused or unexplained suppressions fail lint.
