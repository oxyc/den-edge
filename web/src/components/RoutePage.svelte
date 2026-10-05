<script lang="ts">
  import { onMount, setContext, tick, untrack, type Snippet } from 'svelte';
  import { keyboardInput, trackInputModality } from '../lib/inputModality';
  import { scrolledWithin } from '../lib/scrolled';
  import { PAGE_VISIBILITY, type PageVisibility } from '../lib/pageVisibility.svelte';
  let { active, children }: { active: boolean; children: Snippet } = $props();
  // Start closed: a RoutePage first created in the retained, hidden stack must never get one frame of active
  // observers, idle preloads, or cards before the prop-sync effect runs.
  const visibility = $state<PageVisibility>({ active: false });
  setContext(PAGE_VISIBILITY, visibility);
  $effect(() => {
    visibility.active = active;
  });
  let root: HTMLDivElement;
  let scrolls: { element: HTMLElement; x: number; y: number }[] = [];
  let focused: HTMLElement | null = null;
  let focusKey: string | undefined;
  let controls: {
    element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    value: string;
    checked?: boolean;
  }[] = [];
  let activation = 0;
  onMount(trackInputModality);
  $effect.pre(() => {
    const visible = active;
    untrack(() => {
      if (!root) return;
      const ticket = ++activation;
      if (!visible) {
        // Whatever plays on a page left behind stops with it, at once and silenced, whichever component owns it:
        // the page stays mounted, and its trailer was heard from the page in front of it. Each one starts its
        // own again when its page is back.
        for (const media of root.querySelectorAll<HTMLMediaElement>('video, audio')) {
          media.pause();
          media.muted = true;
        }
        controls = Array.from(
          root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
            'input:not([type="file"]), textarea, select',
          ),
        ).map((element) => ({
          element,
          value: element.value,
          checked: element instanceof HTMLInputElement ? element.checked : undefined,
        }));
        focused = root.contains(document.activeElement)
          ? (document.activeElement as HTMLElement)
          : null;
        focusKey = focused?.closest<HTMLElement>('[data-route-focus-key]')?.dataset.routeFocusKey;
        scrolls = (scrolledWithin(root) as HTMLElement[])
          .filter((element) => element.scrollLeft !== 0 || element.scrollTop !== 0)
          .map((element) => ({ element, x: element.scrollLeft, y: element.scrollTop }));
      } else {
        void tick().then(() => {
          if (!active || activation !== ticket) return;
          // A persistent shell control (such as navbar search) may have opened this page.
          // Restoring the page's old focus must not take focus or the keyboard away from it.
          const currentFocus = document.activeElement;
          if (!currentFocus || currentFocus === document.body || root.contains(currentFocus)) {
            const target = focused?.isConnected
              ? focused
              : focusKey
                ? Array.from(root.querySelectorAll<HTMLElement>('[data-route-focus-key]'))
                    .find((element) => element.dataset.routeFocusKey === focusKey)
                    ?.querySelector<HTMLElement>('a, button, input, [tabindex]')
                : null;
            target?.focus({ preventScroll: true, focusVisible: keyboardInput() });
          }
          const restore = () => {
            if (!active || activation !== ticket) return;
            for (const { element, x, y } of scrolls)
              element.scrollTo({ left: x, top: y, behavior: 'instant' });
            for (const { element, value, checked } of controls) {
              element.value = value;
              if (element instanceof HTMLInputElement && checked !== undefined)
                element.checked = checked;
            }
          };
          restore();
          // Browsers may restore persisted form state after popstate, independently of scrollRestoration.
          requestAnimationFrame(restore);
        });
      }
    });
  });
</script>

<div
  class="route-page"
  bind:this={root}
  hidden={!active}
  inert={!active}
  data-route-page
  data-active={active}
>
  {@render children()}
</div>

<style>
  /* Match the snapshot's formatting context: a hero's negative margin must not collapse
     through the live wrapper and then be applied a second time inside its positioned copy. */
  .route-page {
    display: flow-root;
  }

  [hidden] {
    display: none !important;
  }
</style>
