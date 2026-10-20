// What a poster's ⋯ menu can do to its title (den-edge#236), read from `Library.svelte`'s own handlers by
// context rather than threaded as props through `PosterRow` / `BrowseRow` / `WatchlistPage` / `SearchResults` /
// `Person`. Absent — an isolated test, a guest page — a card offers only what needs no library: More like this
// and Share.

import { getContext, setContext } from 'svelte';
import { blockedTitles } from './blockedTitles.svelte';
import type { Title } from './library';
import { likeId, searchHref, titleHref } from './route';
import { shareOrCopy } from './share';
import type { Notify } from './toast';
import { titleState, type Reaction } from './titleState';
import type { TitleRow } from './wire';

const TITLE_ACTIONS = Symbol('title actions');

export interface TitleActionsContext {
  /** Whether a library is open at all; a guest gets nothing written here. */
  readonly libraryOpen: boolean;
  /** A write already in flight: the menu's write-items show `aria-disabled` rather than losing focus. */
  readonly busy: boolean;
  rowOf: (title: Title) => TitleRow | undefined;
  /** This series' Continue Watching episode, where it has one — what `playHere` would resume. */
  resumeOf: (title: Title) => { season: number; episode: number } | undefined;
  toggleWatchlist: (title: Title, on: boolean) => void;
  toggleSeen: (title: Title, seen: boolean) => void;
  setReaction: (title: Title, reaction: Reaction | null) => void;
  dismissContinueWatching: (title: Title) => void;
  /** Play it on the linked TV; absent for a guest, who has none. */
  play?: (title: Title) => void;
  /** Play it in this browser; absent where nothing here can. */
  playHere?: (title: Title) => void;
  /** Owner-only Kid exceptions. Selecting one opens the fresh Owner-PIN gate owned by Library. */
  readonly kids?: readonly { id: string; name: string; approvals: readonly string[] }[];
  changeKidAccess?: (kid: { id: string; name: string }, title: Title, allow: boolean) => void;
}

export function setTitleActionsContext(context: TitleActionsContext) {
  setContext(TITLE_ACTIONS, context);
}

export function titleActionsContext(): TitleActionsContext | undefined {
  return getContext(TITLE_ACTIONS);
}

export type MenuItem = (
  | { kind: 'item'; label: string; onselect: () => void; disabled?: boolean }
  /** An item that goes to a page: a link there, so it opens in a new tab like any other. */
  | {
      kind: 'link';
      label: string;
      href: string;
      /** Keep an ordinary activation in the mounted app; modified clicks retain native link behaviour. */
      onselect?: () => void;
      disabled?: undefined;
    }
  | { kind: 'checkbox'; label: string; checked: boolean; onselect: () => void; disabled?: boolean }
  | {
      kind: 'radio';
      label: string;
      group: string;
      checked: boolean;
      onselect: () => void;
      disabled?: boolean;
    }
) & {
  /** A quieter second line under the label (`ActionMenu`), at most two lines before it is cut short. */
  description?: string;
};

const REACTIONS: [Reaction, string][] = [
  ['dislike', 'Not for me'],
  ['like', 'Like'],
  ['love', 'Love'],
];

/**
 * The items a poster's ⋯ offers for this title — the same handlers the title page's own controls call, so a
 * press here and a press there can never disagree about what happened.
 */
export function titleMenuItems(
  title: Title,
  ctx: TitleActionsContext | undefined,
  {
    continueWatching = false,
    href,
    notify,
  }: { continueWatching?: boolean; href: string; notify?: Notify },
): MenuItem[] {
  const items: MenuItem[] = [];
  if (ctx?.libraryOpen) {
    const { listed, seen, reaction } = titleState(ctx.rowOf(title));
    const busy = ctx.busy;
    // The real refusal is `playGuard` (`Library.svelte`'s `play`/`playHere`): this is only what the item
    // shows cheaply, from a title this browser already opened the page of this session (`blockedTitles.ts`).
    // An unknown title still offers Play here — pressing it runs `playGuard` exactly the same.
    const blocked = blockedTitles.of(title);
    if (ctx.playHere && !blocked) {
      const target = title.type === 'tv' ? ctx.resumeOf(title) : undefined;
      items.push({
        kind: 'link',
        label: target ? `Resume S${target.season} · E${target.episode}` : 'Play',
        href: titleHref({ ...title, ...target, play: true }),
        onselect: () => ctx.playHere?.(title),
      });
    }
    if (ctx.play && !blocked) {
      items.push({ kind: 'item', label: 'Play on TV', onselect: () => ctx.play?.(title) });
    }
    items.push({
      kind: 'checkbox',
      label: listed ? 'Remove from watchlist' : 'Add to watchlist',
      checked: listed,
      disabled: busy,
      onselect: () => ctx.toggleWatchlist(title, !listed),
    });
    items.push({
      kind: 'checkbox',
      label: seen ? 'Mark as unseen' : 'Mark as seen',
      checked: seen,
      disabled: busy,
      onselect: () => ctx.toggleSeen(title, !seen),
    });
    for (const [value, label] of REACTIONS) {
      items.push({
        kind: 'radio',
        label,
        group: 'reaction',
        checked: reaction === value,
        disabled: busy,
        onselect: () => ctx.setReaction(title, reaction === value ? null : value),
      });
    }
    if (continueWatching) {
      items.push({
        kind: 'item',
        label: 'Remove from Continue Watching',
        disabled: busy,
        onselect: () => ctx.dismissContinueWatching(title),
      });
    }
    for (const kid of ctx.kids ?? []) {
      const approved = kid.approvals.includes(`${title.type}:${title.id}`);
      items.push({
        kind: 'item',
        label: `${approved ? 'Remove' : 'Allow'} for ${kid.name}`,
        disabled: busy,
        onselect: () => ctx.changeKidAccess?.(kid, title, !approved),
      });
    }
  }
  items.push({
    kind: 'link',
    label: 'More like this',
    href: searchHref('', { chips: [likeId(title)] }),
  });
  items.push({
    kind: 'item',
    label: 'Share',
    onselect: () =>
      void shareOrCopy({
        title: title.title,
        url: `${__DEN_TV_API_ORIGIN__ || location.origin}${href}`,
      }).then((result) => {
        if (result === 'copied') notify?.('Link copied');
      }),
  });
  return items;
}
