<script lang="ts">
  import { onMount, tick, type Snippet } from 'svelte';
  import {
    capturePage,
    previewHistory,
    prepareSwipeLanding,
    type PageSnapshot,
  } from './lib/pageSnapshot';
  import { swipeHistory } from './lib/swipeBack';
  import LoadingSnapshot from './components/LoadingSnapshot.svelte';
  import RoutePage from './components/RoutePage.svelte';
  import { Navigation, appPath, routeKey } from './lib/navigation';
  import { parseRoute, type Route } from './lib/route';

  let {
    children,
    onchange,
  }: { children: Snippet<[Route, boolean]>; onchange: (route: Route) => void } = $props();
  // The parent keys this entire scope by the paired library, including all retained pages and data.
  const navigation = new Navigation(location.pathname + location.search);
  let current = $state.raw(navigation.current);
  let pages = $state.raw([...navigation.pages.values()]);
  let revision = 0;
  let restoring = false;
  let requestedKey = routeKey(navigation.current.route);
  let requestedPageKey = navigation.current.key;
  let transition: ViewTransition | undefined;
  let loadingSnapshot = $state.raw<PageSnapshot | null>(null);

  onMount(() => {
    const previous = history.scrollRestoration;
    history.scrollRestoration = 'manual';
    let scope = crypto.randomUUID();
    let position = 0;
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Imperative history bookkeeping; only the explicit current/pages state drives rendering.
    const entries = new Map<number, { routeKey: string; pageKey: string }>([
      [0, { routeKey: routeKey(current.route), pageKey: current.key }],
    ]);
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Frozen DOM cache is outside Svelte rendering and must not create reactive dependencies.
    const snapshots = new Map<string, PageSnapshot>();
    let swiping = false;
    let stopLoading = () => {};
    function watchLoading(snapshot: PageSnapshot | null, ticket: number) {
      const page = document.querySelector<HTMLElement>('[data-route-page][data-active="true"]');
      if (!snapshot || !page?.querySelector('[data-route-loading]')) return;
      loadingSnapshot = snapshot;
      let settling = false;
      const ready = () => {
        if (settling || page.querySelector('[data-route-loading]')) return;
        settling = true;
        void prepareSwipeLanding().then(() => {
          if (ticket !== revision) return;
          if (page.querySelector('[data-route-loading]')) {
            settling = false;
            return;
          }
          observer.disconnect();
          loadingSnapshot = null;
        });
      };
      const observer = new MutationObserver(ready);
      observer.observe(page, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-route-loading'],
      });
      stopLoading = () => observer.disconnect();
      ready();
    }
    history.replaceState({ ...history.state, denNavigation: { scope, position } }, '');
    const destination = (offset: number) =>
      snapshots.get(entries.get(position + offset)?.pageKey ?? '');
    const previewDestination = (offset: number, direction: 1 | -1) => {
      const saved = destination(offset);
      if (!saved) return null;
      // Retained pages can receive data while hidden. Prepare their current layout, rather
      // than handing off from an old clone to a newer live page.
      const prepared = saved.refresh();
      return previewHistory(prepared, direction);
    };
    const inScope = () => history.state?.denNavigation?.scope === scope;
    const stopSwipe = swipeHistory(document, {
      back: {
        canNavigate: () => inScope() && position > 0 && !!destination(-1),
        navigate: () => {
          swiping = true;
          history.back();
        },
        preview: () => previewDestination(-1, 1),
      },
      forward: {
        canNavigate: () => inScope() && !!destination(1),
        navigate: () => {
          swiping = true;
          history.forward();
        },
        preview: () => previewDestination(1, -1),
      },
    });
    onchange(current.route);
    const address = () => location.pathname + location.search;
    async function follow(path: string, push: boolean, replace = false) {
      if (push && appPath(path, location.href) === null) return;
      const key = routeKey(parseRoute(path));
      // The same page at a new address: a search query that grew by a letter is not somewhere a person
      // navigated to, and giving it a history entry would bury the page they came from under the spelling
      // of what they typed. The entry is rewritten in place and the page keeps its scroll and its state.
      if (replace) {
        if (address() !== path) history.replaceState(history.state, '', path);
        // Only the address and the route it names. The page itself is the one already on screen, so its
        // scroll, its snapshot and its place in the ledger are left exactly as they are.
        current.route = parseRoute(path);
        onchange(current.route);
        return;
      }
      const previousPosition = position;
      if (!push) {
        const state = history.state?.denNavigation;
        if (state?.scope === scope && entries.get(state.position)?.routeKey === key) {
          position = state.position;
        } else {
          // Address-bar hash changes and entries from an earlier mount have no ledger entry.
          // Start a fresh segment at the actual route instead of treating it as the old Home.
          scope = crypto.randomUUID();
          position = 0;
          entries.clear();
          entries.set(position, { routeKey: key, pageKey: key });
          history.replaceState({ ...history.state, denNavigation: { scope, position } }, '');
        }
      }
      if (key === requestedKey && (push || entries.get(position)?.pageKey === requestedPageKey)) {
        // Search is one page at many addresses. Opening a chip or switching Movies and Series is somewhere
        // a person went, so it gets its own entry, and Back returns to the chip before it — on the same
        // page, which keeps its scroll and its state as it does while a query is typed. People is browsed the
        // same way.
        if (key !== 'search' && key !== 'people') return;
        if (push) {
          if (address() === path) return;
          position++;
          for (const at of entries.keys()) if (at >= position) entries.delete(at);
          entries.set(position, { routeKey: key, pageKey: requestedPageKey });
          history.pushState({ denNavigation: { scope, position } }, '', path);
        }
        current.route = parseRoute(path);
        onchange(current.route);
        return;
      }
      requestedKey = key;
      if (push || !swiping) {
        // The preview belongs to the history position where the gesture began. A competing
        // navigation invalidates it before an asynchronous finish can traverse a different entry.
        document.dispatchEvent(new Event('den:swipe-cancel'));
        swiping = false;
      }
      // Loading covers may depict a different route. Never save that cover as this page's history.
      const captured = capturePage();
      const outgoing = loadingSnapshot ?? captured;
      stopLoading();
      loadingSnapshot = null;
      if (!restoring) {
        navigation.save(window.scrollX, window.scrollY);
        if (captured) snapshots.set(current.key, captured);
      }
      restoring = true;
      if (push && address() !== path) {
        position++;
        for (const at of entries.keys()) if (at >= position) entries.delete(at);
        const pageKey =
          key.startsWith('title/') || key.startsWith('person/') || key.startsWith('service/')
            ? crypto.randomUUID()
            : key;
        entries.set(position, { routeKey: key, pageKey });
        history.pushState({ denNavigation: { scope, position } }, '', path);
      }
      document.documentElement.dataset.denNavigation =
        !push && position < previousPosition ? 'back' : 'forward';
      document.documentElement.dataset.denOpeningDetail = String(
        push && (key.startsWith('title/') || key.startsWith('person/')),
      );
      const visitKey = entries.get(position)?.pageKey ?? key;
      requestedPageKey = visitKey;
      const ticket = ++revision;
      transition?.skipTransition();
      const update = async () => {
        if (ticket !== revision) return;
        current = navigation.visit(path, visitKey);
        // Selecting a detail is a new visit; history traversal restores the saved position.
        // Top-level tabs still retain their browsing position when selected explicitly.
        if (push && (current.route.page === 'title' || current.route.page === 'person')) {
          navigation.save(0, 0);
        }
        navigation.prune(new Set(Array.from(entries.values(), (entry) => entry.pageKey)));
        for (const key of snapshots.keys()) if (!navigation.pages.has(key)) snapshots.delete(key);
        pages = [...navigation.pages.values()];
        onchange(current.route);
        await tick();
        if (ticket !== revision) return;
        window.scrollTo({ left: current.x, top: current.y, behavior: 'instant' });
        // Flush RoutePage's nested-scroll restoration before the new snapshot is captured.
        // Rendering is paused here, so waiting for an animation frame would stall the transition.
        await tick();
        if (ticket === revision) {
          watchLoading(outgoing, ticket);
          await tick();
          if (ticket !== revision) return;
          restoring = false;
          if (swiping) {
            await prepareSwipeLanding();
            if (ticket !== revision) return;
            swiping = false;
            document.dispatchEvent(new Event('den:swipe-restored'));
          }
        }
      };
      if (
        swiping ||
        !document.startViewTransition ||
        matchMedia('(prefers-reduced-motion: reduce)').matches ||
        document.hidden
      ) {
        await update();
        return;
      }
      transition = document.startViewTransition(update);
      // A rapid second navigation or a native browser transition can skip the animation.
      // The update callback still runs, so routing never depends on animation support.
      void transition.ready.catch(() => {});
      void transition.finished.catch(() => {});
    }
    const backRequested = () => {
      if (inScope() && position > 0) history.back();
      else void follow('/', true);
    };
    // Back to the entry before this page's run of entries, in one traversal.
    const outRequested = () => {
      const here = entries.get(position)?.routeKey;
      let first = position;
      while (first > 0 && entries.get(first - 1)?.routeKey === here) first--;
      if (inScope() && first > 0) history.go(first - 1 - position);
      else void follow('/', true);
    };
    const requested = (event: Event) => {
      const { path, replace } = (event as CustomEvent<{ path: string; replace?: boolean }>).detail;
      void follow(path, true, replace);
    };
    const traversed = () => void follow(address(), false);
    const clicked = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const anchor = (event.target as Element)?.closest?.('a');
      if (
        !anchor ||
        anchor.hasAttribute('download') ||
        (anchor.target && anchor.target !== '_self')
      )
        return;
      const path = appPath(anchor.href, location.href);
      if (path === null) return;
      event.preventDefault();
      void follow(path, true);
    };
    document.addEventListener('click', clicked);
    document.addEventListener('den:navigate', requested);
    document.addEventListener('den:back', backRequested);
    document.addEventListener('den:back-out', outRequested);
    window.addEventListener('popstate', traversed);
    return () => {
      transition?.skipTransition();
      delete document.documentElement.dataset.denNavigation;
      delete document.documentElement.dataset.denOpeningDetail;
      stopLoading();
      stopSwipe();
      revision++;
      history.scrollRestoration = previous;
      document.removeEventListener('click', clicked);
      document.removeEventListener('den:navigate', requested);
      document.removeEventListener('den:back', backRequested);
      document.removeEventListener('den:back-out', outRequested);
      window.removeEventListener('popstate', traversed);
    };
  });
</script>

{#each pages as page (page.key)}
  <RoutePage active={current.key === page.key}>
    <!-- One page's error stays that page's: without a boundary it reached the root and took every page down,
         including one kept out of sight. -->
    <svelte:boundary onerror={(error) => console.error('den: a page failed', error)}>
      {@render children(page.route, current.key === page.key)}
      {#snippet failed(_, reset)}
        <div class="failed" role="alert">
          <p>Something went wrong on this page.</p>
          <button onclick={reset}>Try again</button>
        </div>
      {/snippet}
    </svelte:boundary>
  </RoutePage>
{/each}

{#if loadingSnapshot}
  <LoadingSnapshot snapshot={loadingSnapshot} />
{/if}

<style>
  .failed {
    padding-top: 24px;
    color: var(--muted);
  }

  .failed button {
    min-height: 44px;
    padding: 8px 0;
    border: 0;
    background: none;
    color: var(--accent);
    cursor: pointer;
  }

  .failed button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
  }

  /* The outgoing snapshot stays opaque underneath the incoming page: no fade through the background. */
  :global(::view-transition-group(root)) {
    animation-duration: 180ms;
    animation-timing-function: cubic-bezier(0.2, 0, 0, 1);
  }

  :global(::view-transition-old(root)) {
    animation: none;
    mix-blend-mode: normal;
  }

  :global(::view-transition-new(root)) {
    animation: 180ms cubic-bezier(0.2, 0, 0, 1) both den-page-reveal;
    mix-blend-mode: normal;
  }

  @keyframes -global-den-page-reveal {
    from {
      opacity: 0;
    }

    to {
      opacity: 1;
    }
  }

  :global(html[data-den-opening-detail='true']::view-transition-new(root)) {
    animation: 180ms cubic-bezier(0.2, 0, 0, 1) both den-detail-open;
  }

  @keyframes -global-den-detail-open {
    from {
      opacity: 0;
      transform: translateY(8px);
    }

    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  /* Back reveals the restored page beneath a frozen outgoing snapshot. Their opaque surfaces overlap
     throughout the movement, including when the two pages have very different scroll positions. */
  :global(html[data-den-navigation='back']::view-transition-old(root)) {
    z-index: 2;
    animation: 240ms cubic-bezier(0.2, 0.7, 0.2, 1) both den-back-out;
  }

  :global(html[data-den-navigation='back']::view-transition-new(root)) {
    z-index: 1;
    animation: 240ms cubic-bezier(0.2, 0.7, 0.2, 1) both den-back-in;
  }

  @keyframes -global-den-back-out {
    from {
      transform: translateX(0);
      opacity: 1;
    }

    to {
      transform: translateX(100%);
      opacity: 1;
    }
  }

  @keyframes -global-den-back-in {
    from {
      transform: translateX(-18%);
      opacity: 1;
    }

    to {
      transform: translateX(0);
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    :global(::view-transition-group(root)),
    :global(::view-transition-new(root)),
    :global(html[data-den-opening-detail='true']::view-transition-new(root)),
    :global(html[data-den-navigation='back']::view-transition-old(root)),
    :global(html[data-den-navigation='back']::view-transition-new(root)) {
      animation: none;
    }
  }
</style>
