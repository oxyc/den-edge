// A title this browser already knows is blocked by the household's parental ceiling, from having opened its
// page: `Detail.svelte` computes `isBlocked(detail.certifications, region, ceiling)` for its own Play/Sources/
// trailer, and marks the result here so a poster's ⋯ menu (`titleActions.ts`) can reuse it rather than offer
// Play for a title its own page would refuse.
//
// Not everywhere: a poster for a title never opened this session carries no signal yet and still offers Play —
// nothing today fetches a certification at poster scope (a catalog `Title` and a synced `TitleRow` both lack
// one), so there is nothing cheaper to check first. The same gap exists on the billboard's own Play button.

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
