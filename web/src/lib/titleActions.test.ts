import { describe, expect, it, vi } from 'vitest';
import { titleMenuItems, type TitleActionsContext } from './titleActions';
import type { Title } from './library';

const title: Title = { type: 'movie', id: 550, title: 'Fight Club' };

function context(approved: boolean) {
  const changeKidAccess = vi.fn();
  const ctx = {
    libraryOpen: true,
    busy: false,
    rowOf: () => undefined,
    resumeOf: () => undefined,
    toggleWatchlist: vi.fn(),
    toggleSeen: vi.fn(),
    setReaction: vi.fn(),
    dismissContinueWatching: vi.fn(),
    kids: [
      {
        id: '1'.repeat(32),
        name: 'Kids',
        approvals: approved ? ['movie:550'] : [],
      },
    ],
    changeKidAccess,
  } satisfies TitleActionsContext;
  return { ctx, changeKidAccess };
}

describe('poster Kid access action', () => {
  it('offers Allow, then asks the shared handler for this title and Kid', () => {
    const { ctx, changeKidAccess } = context(false);
    const item = titleMenuItems(title, ctx, { href: '/movie/550' }).find(
      ({ label }) => label === 'Allow for Kids',
    );
    if (item?.kind !== 'item') throw new Error('Allow for Kids is not an item');
    item.onselect();
    expect(changeKidAccess).toHaveBeenCalledWith(
      { id: '1'.repeat(32), name: 'Kids', approvals: [] },
      title,
      true,
    );
  });

  it('offers Remove when this Kid already has the title', () => {
    const { ctx } = context(true);
    expect(titleMenuItems(title, ctx, { href: '/movie/550' }).map(({ label }) => label)).toContain(
      'Remove for Kids',
    );
  });
});

describe('poster More like this', () => {
  it('is a link to Search with the title’s Like, so it opens in a new tab like any other', () => {
    const item = titleMenuItems(title, undefined, { href: '/movie/550' }).find(
      ({ label }) => label === 'More like this',
    );
    expect(item).toEqual({
      kind: 'link',
      label: 'More like this',
      href: '/search?c=like-movie-550',
    });
  });
});
