<script lang="ts">
  import { onMount, setContext, tick, untrack, type Snippet } from 'svelte';
  import { keyboardInput, trackInputModality } from '../lib/inputModality';
  import { scrolledWithin } from '../lib/scrolled';
  import { PAGE_VISIBILITY, type PageVisibility } from '../lib/pageVisibility.svelte';
  let {
    active,
    entering = false,
    children,
  }: { active: boolean; entering?: boolean; children: Snippet } = $props();
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
  let focusReplacement: MutationObserver | undefined;
  let clearPointerFocus: (() => void) | undefined;
  let cancelFrameRestore: (() => void) | undefined;
  function rememberRouteFocus(event: PointerEvent): void {
    const holder = (event.target as Element | null)?.closest<HTMLElement>('[data-route-focus-key]');
    if (!holder || !root.contains(holder)) return;
    const target = holder.querySelector<HTMLElement>('a, button, input, [tabindex]');
    if (!target) return;
    focused = target;
    focusKey = holder.dataset.routeFocusKey;
  }
  const focusTarget = () =>
    focusKey
      ? Array.from(root.querySelectorAll<HTMLElement>('[data-route-focus-key]'))
          .find((element) => element.dataset.routeFocusKey === focusKey)
          ?.querySelector<HTMLElement>('a, button, input, [tabindex]')
      : null;
  const focusRestored = (target: HTMLElement) => {
    const keyboard = keyboardInput();
    clearPointerFocus?.();
    if (!keyboard) {
      root.dataset.restoredPointerFocus = '';
      const clear = () => {
        root.removeAttribute('data-restored-pointer-focus');
        document.removeEventListener('keydown', clear, true);
        if (clearPointerFocus === clear) clearPointerFocus = undefined;
      };
      clearPointerFocus = clear;
      document.addEventListener('keydown', clear, { capture: true, once: true });
    }
    target.focus({ preventScroll: true, focusVisible: keyboard });
  };
  onMount(() => {
    trackInputModality();
    root.addEventListener('pointerdown', rememberRouteFocus, { passive: true });
    return () => {
      if (__DEN_TV__) cancelFrameRestore?.();
      focusReplacement?.disconnect();
      clearPointerFocus?.();
      root.removeEventListener('pointerdown', rememberRouteFocus);
    };
  });
  $effect.pre(() => {
    const visible = active;
    untrack(() => {
      if (!root) return;
      const ticket = ++activation;
      if (__DEN_TV__) cancelFrameRestore?.();
      focusReplacement?.disconnect();
      focusReplacement = undefined;
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
        const activeFocus = root.contains(document.activeElement)
          ? (document.activeElement as HTMLElement)
          : null;
        if (activeFocus) focused = activeFocus;
        focusKey = focused?.closest<HTMLElement>('[data-route-focus-key]')?.dataset.routeFocusKey;
        scrolls = (scrolledWithin(root) as HTMLElement[])
          .filter((element) => element.scrollLeft !== 0 || element.scrollTop !== 0)
          .map((element) => ({ element, x: element.scrollLeft, y: element.scrollTop }));
      } else {
        let interrupted = false;
        let stopRestore: (() => void) | undefined;
        if (__DEN_TV__) {
          // The navigation observer can focus this page before tick resolves. Input at that boundary
          // must cancel the initial restoration as well as its later animation-frame pass.
          const cancel = () => {
            interrupted = true;
            window.removeEventListener('den:tv-input', cancel);
            window.removeEventListener('pointerdown', cancel, true);
          };
          stopRestore = cancelFrameRestore = cancel;
          window.addEventListener('den:tv-input', cancel, { once: true });
          window.addEventListener('pointerdown', cancel, { capture: true, once: true });
        }
        void tick().then(() => {
          if (!active || activation !== ticket || (__DEN_TV__ && interrupted)) return;
          // A persistent shell control (such as navbar search) may have opened this page.
          // Restoring the page's old focus must not take focus or the keyboard away from it.
          const restoreFocus = (allowCurrentPage: boolean) => {
            const currentFocus = document.activeElement;
            const currentPage = currentFocus?.closest<HTMLElement>('[data-route-page]');
            if (
              currentFocus &&
              currentFocus !== document.body &&
              currentPage?.dataset.active !== 'false' &&
              !(allowCurrentPage && root.contains(currentFocus))
            )
              return null;
            const target = focused?.isConnected ? focused : focusTarget();
            if (target) focusRestored(target);
            return target;
          };
          const restoredFocus = restoreFocus(true);
          if (restoredFocus) {
            focusReplacement = new MutationObserver(() => {
              if (!active || activation !== ticket) {
                focusReplacement?.disconnect();
                return;
              }
              if (restoredFocus.isConnected || document.activeElement !== document.body) return;
              const replacement = focusTarget();
              if (!replacement) return;
              focused = replacement;
              focusRestored(replacement);
              focusReplacement?.disconnect();
              focusReplacement = undefined;
            });
            focusReplacement.observe(root, { childList: true, subtree: true });
          }
          const restore = () => {
            if (!active || activation !== ticket) return;
            // A keyed row can replace its card while fresh metadata supersedes the retained answer. If that detached
            // the element just focused, restore the same semantic card after the replacement without stealing focus
            // from a control the viewer reached in the meantime.
            restoreFocus(false);
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
          if (__DEN_TV__) {
            requestAnimationFrame(() => {
              const shouldRestore = !interrupted;
              stopRestore?.();
              if (cancelFrameRestore === stopRestore) cancelFrameRestore = undefined;
              if (shouldRestore) restore();
            });
          } else requestAnimationFrame(restore);
        });
      }
    });
  });
</script>

<div
  class="route-page"
  class:entering
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

  /* A page arriving fades up from partly seen, on the compositor, as it is shown: an animation restarts when a
     hidden page is displayed again. It replaced a view-transition cross-fade from fully transparent, which held
     a tap to first frame at 118.7 ms against 56.8 ms without it (4x CPU, e2e fixture). Opacity alone, because a
     transform here would move the page's fixed descendants (the player, loading spinners) while it ran. */
  .entering {
    animation: route-page-enter 150ms ease-out;
  }

  @keyframes route-page-enter {
    from {
      opacity: 0.6;
    }
  }
</style>
