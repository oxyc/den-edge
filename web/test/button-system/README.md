# Den button system demo

This is an isolated design fixture, not a production migration. Open
`/test/button-system.html` in the Vite dev server.

| Desktop | Mobile |
| --- | --- |
| [Full desktop capture](screenshots/desktop.png) | [Full mobile capture](screenshots/mobile.png) |

## Inventory

Den's current button surfaces fall into a small set of behaviors even though their CSS is repeated in component-local styles:

- Hero and detail actions: `TitleActions`, `Billboard`, `Detail`, `DetailMedia`.
- Settings and dialogs: `Settings`, `LinkTV`, sharing, recovery, connections, imports, confirmation, and invite dialogs.
- Stateful controls: Watchlist, Seen, reactions, type filters, tabs, facets, service picks, and check grids.
- Menus and dense choices: `ActionMenu`, search history, source/download actions, and navigation controls.
- Player chrome: transport, Cast, skip, picker, close, notice, and recovery actions.
- Utility and failure actions: retry, load more, clear, copy, cancel, undo, expand, and close.
- Destructive actions: guest/device removal, download removal, unlinking, and confirmation flows.

The repeated rules currently express roughly the same control at 36, 40, 44, and 48 px; `primary`, `quiet`, `pill`, `control`, `more`, `retry`, `close`, and bare `button` styles each redefine some combination of fill, border, focus, disabled, and pressed behavior.

## Proposed API

`DenButton` separates intent from context:

- `variant`: `primary`, `secondary`, `tertiary`, `device`, `destructive`, `menu`, or `player`.
- `size`: `large`, `regular`, `compact`, or `icon`.
- State: `pressed`, `busy`, and `disabled` map to native/ARIA state rather than page-specific classes.
- Content: a stable `label`, optional shared `icon`, and required `ariaLabel` for icon-only controls.

Stateful actions keep a stable label and use `aria-pressed`; loading uses `aria-busy` and preserves focus; native `disabled` is reserved for genuinely unavailable actions. Focus is always visible. Icon-only targets stay 44×44. Motion is limited to short color/press feedback and is removed under reduced motion—there is no `will-change`.

The candidate component and icon set live under `test/` deliberately. If the direction is approved, production adoption should happen surface by surface, deleting the replaced local CSS in the same change rather than layering these rules over it.
