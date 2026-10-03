// A cheap hint only: whether this browser already knows a title is blocked by the household's parental ceiling,
// from having opened its page (`Detail.svelte` computes `isBlocked(detail.certifications, region, ceiling)` for
// its own Play/Sources/trailer, and marks the result here). `Detail.svelte` is the only writer.
//
// The poster ⋯ menu (`titleActions.ts`) reads this to skip drawing Play for a title it already knows is
// blocked, so the item doesn't flash and then fail — but it is not what actually refuses anything: `playGuard`
// (`Library.svelte`'s `play`/`playHere`, run before every start) is the one place that does, with its own
// lookup, so a title never opened this session — this map has nothing on it — is refused there just the same.

import { titleKey } from './library';

class BlockedTitles {
  #by = $state.raw<Record<string, boolean>>({});

  of(title: { type: string; id: number }): boolean {
    return !!this.#by[titleKey(title)];
  }

  mark(title: { type: string; id: number }, blocked: boolean): void {
    const key = titleKey(title);
    if (!!this.#by[key] === blocked) return;
    this.#by = { ...this.#by, [key]: blocked };
  }
}

export const blockedTitles = new BlockedTitles();
