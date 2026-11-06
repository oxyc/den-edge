<!-- Settings › Advanced › Recovery code (den-spec recovery-code §6): make a code, show it once, have its last group
     typed back before it goes live, and show what den-edge counts of it. The code lives in this component's memory
     only, from the moment it is made until this screen closes; leaving before confirming ends it. -->
<script lang="ts">
  import Button from '../components/Button.svelte';
  import { onMount, untrack } from 'svelte';
  import Confirm from './Confirm.svelte';
  import Loading from '../components/Loading.svelte';
  import { copyText } from '../lib/clipboard';
  import { derive, DeriveFailed, deviceCouldNot, newCode } from '../lib/recovery';
  import type {
    LibraryQueryResult,
    LibraryTaskResult,
    RecoveryView,
  } from '../lib/libraryServiceProtocol';
  import type { Immutable, LibraryModel } from '../lib/libraryModel.svelte';
  import { i18n } from '../lib/i18n.svelte';

  interface PreparedCode {
    code: string;
    locator: string;
  }

  const toBase64url = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

  let {
    view,
    ready,
    authority,
    run,
  }: {
    view?: Immutable<RecoveryView>;
    ready: boolean;
    authority: LibraryModel;
    run: (action: () => Promise<unknown>) => Promise<boolean>;
  } = $props();

  // Settings keys this component by model identity. Every operation and late teardown cleanup stays on the authority
  // that created this instance, even while the parent replaces its reactive prop.
  const owned = untrack(() => authority);

  async function abandon(locator: string) {
    try {
      const result = (await owned.abandonRecovery(locator)).result as Extract<
        LibraryTaskResult,
        { kind: 'recovery.abandon' }
      >;
      return result.outcome;
    } catch {
      return 'failed' as const;
    }
  }

  const day = (at: number) =>
    new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

  let phase = $state(0);
  let prepared = $state<PreparedCode | null>(null);
  let typed = $state('');
  let message = $state('');
  let messageBad = $state(false);
  let copyResult = $state('');
  let codeEl = $state<HTMLElement>();
  let pendingCleanup = $state<string | null>(null);
  let attempt = 0;
  let active: string | null = null;

  const failures = {
    full: 'Den holds too many codes for this library just now. Try again in a minute.',
    taken: 'That code collided with another. Make a new one.',
    failed: 'Couldn’t save the code. Check that this device is on your network.',
    waits: 'Available after the library update.',
  };

  function showMessage(text: string, bad = true) {
    message = text;
    messageBad = bad;
  }

  async function make() {
    const current = ++attempt;
    phase = 1;
    message = '';
    copyResult = '';
    try {
      const made = await newCode();
      const derived = await derive(made.data, { op: 'make' });
      if (current !== attempt) {
        derived.wrapKey.fill(0);
        return;
      }
      const createdAt = Date.now();
      let sealed: string;
      try {
        sealed = (
          (await owned.sealRecovery(derived.locator, toBase64url(derived.wrapKey), createdAt))
            .result as Extract<LibraryQueryResult, { kind: 'recovery.seal' }>
        ).sealed;
      } finally {
        derived.wrapKey.fill(0);
      }
      const outcome = (
        (await owned.beginRecovery(derived.locator, sealed, createdAt)).result as Extract<
          LibraryTaskResult,
          { kind: 'recovery.begin' }
        >
      ).outcome;
      if (current !== attempt) {
        if (outcome === 'begun') await abandon(derived.locator);
        return;
      }
      if (outcome !== 'begun') {
        phase = 0;
        showMessage(failures[outcome as keyof typeof failures] ?? failures.failed);
        return;
      }
      prepared = {
        code: made.code,
        locator: derived.locator,
      };
      typed = '';
    } catch (error) {
      if (current !== attempt) return;
      console.warn('den: a recovery code could not be made', error);
      phase = 0;
      showMessage(error instanceof DeriveFailed ? deviceCouldNot.make : failures.failed);
    }
  }

  async function save() {
    const made = prepared;
    if (!made) return;
    if (typed.replace(/[\s-]/g, '').toUpperCase() !== made.code.slice(-4)) {
      showMessage('That isn’t the last group of your code. Check what you wrote down.');
      return;
    }
    phase = 3;
    message = '';
    active = made.locator;
    let outcome: 'confirmed' | 'lost' | 'failed';
    try {
      outcome = (
        (await owned.confirmRecovery(made.locator)).result as Extract<
          LibraryTaskResult,
          { kind: 'recovery.confirm' }
        >
      ).outcome;
    } catch {
      outcome = 'failed';
    }
    if (active !== made.locator) {
      // Teardown forgot the secret while this request owned the locator. A pending/unknown answer still needs the
      // exact authority's serialized, pending-only cleanup; a committed or lost answer is already final.
      if (outcome === 'failed') void abandon(made.locator);
      return;
    }
    active = null;
    if (outcome === 'confirmed') {
      end();
      showMessage('Your recovery code is on.', false);
    } else if (outcome === 'lost') {
      end();
      phase = 5;
      showMessage('That pending recovery code was replaced. Make a new one.');
    } else {
      phase = 0;
      showMessage(
        'Couldn’t save that. Check that this device is on your network, then confirm again.',
      );
    }
  }

  /** The code leaves memory: this screen no longer holds it. */
  function end() {
    prepared = null;
    typed = '';
    phase = 0;
  }

  async function cancel() {
    attempt++;
    const made = prepared;
    end();
    if (made) await cancelPending(made.locator);
  }

  async function cancelPending(locator: string) {
    active = locator;
    pendingCleanup = locator;
    phase = 4;
    message = '';
    const outcome = await abandon(locator);
    if (active !== locator || pendingCleanup !== locator) return;
    active = null;
    if (outcome === 'failed') {
      phase = 0;
      showMessage('Couldn’t cancel that recovery code setup. Check your connection and try again.');
      return;
    }
    pendingCleanup = null;
    phase = outcome === 'lost' ? 5 : 0;
    if (outcome === 'confirmed')
      showMessage('Your recovery code was already saved and remains on.', false);
    else if (outcome === 'lost')
      showMessage('That pending recovery code was replaced. Make a new one.');
  }

  async function off() {
    message = '';
    if (!(await run(() => owned.disableRecovery()))) showMessage(failures.failed);
  }

  /**
   * Onto the clipboard, and nothing more: no clear is attempted. A browser lets a page read the clipboard (which a
   * clear only if it still holds the code needs) only inside a gesture, and a blind clear would destroy whatever the
   * person copied since (§6). The page asks them to clear it themselves.
   */
  async function copy(code: string) {
    const result = await copyText(code, () => getSelection()?.selectAllChildren(codeEl!));
    copyResult = result;
  }

  // Leaving with a code shown and not confirmed ends it; a closed tab leaves that to the next reconcile.
  onMount(() => () => {
    attempt++;
    const made = prepared;
    const cleanup = pendingCleanup;
    const operationOwns =
      (phase === 3 && active === made?.locator) ||
      (phase === 4 && active === (made?.locator ?? cleanup));
    active = null;
    end();
    pendingCleanup = null;
    const locator = made?.locator ?? cleanup;
    if (!operationOwns && locator) void abandon(locator);
  });

  const live = $derived(view?.live ?? null);
</script>

<h3>Recovery code</h3>
{#each view?.notices ?? [] as notice (notice)}<p class="status" role="status">
    {i18n.phrase(notice)}
  </p>{/each}

{#if prepared}
  {@const made = prepared!}
  <div class="code-screen">
    <p>
      <b>Anyone with this code can open your library.</b> Write it down or keep it in a password manager.
      Den can’t show it again.
    </p>
    <b class="code" data-no-swipe bind:this={codeEl}>{made.code}</b>
    <span class="actions">
      <Button
        variant="secondary"
        label={copyResult === 'copied' ? 'Copied' : 'Copy'}
        onclick={() => void copy(made.code)}
      />
    </span>
    {#if copyResult === 'manual'}<p class="status" role="status">Select and copy the code.</p>{/if}
    <p class="small" role="status">
      {copyResult === 'copied' ? 'Copied to your clipboard. ' : ''}Clipboard history and your
      system’s clipboard sync can carry a copied code to other devices. Once the code is saved, copy
      something else to clear it.
    </p>
    <form
      class="form"
      onsubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <input
        class="field mono"
        autocomplete="off"
        autocapitalize="characters"
        spellcheck="false"
        maxlength="4"
        placeholder="Last 4 characters"
        aria-label="The code’s last four characters"
        bind:value={typed}
      />
      <Button
        type="submit"
        variant="primary"
        label={phase === 3 ? 'Saving…' : 'I’ve saved it'}
        disabled={phase === 3 || typed.trim().length < 4}
      />
      <Button
        variant="secondary"
        label="Cancel"
        disabled={phase === 3}
        onclick={() => void cancel()}
      />
    </form>
  </div>
{:else if phase === 5}
  <span class="actions">
    <Button
      variant="secondary"
      label="Close"
      onclick={() => {
        phase = 0;
        message = '';
      }}
    />
  </span>
{:else if pendingCleanup}
  <span class="actions">
    <Button
      variant="secondary"
      label="Try again"
      disabled={phase === 4}
      onclick={() => pendingCleanup && void cancelPending(pendingCleanup)}
    />
  </span>
{:else if !ready}
  <p class="status">Your library isn’t open yet.</p>
{:else if view?.availability === 'waits'}
  <p class="status">Available after the library update.</p>
{:else}
  {#if view === undefined}
    <p class="status" role="status">Checking your recovery code…</p>
  {:else if view.broken}
    <p class="status bad" role="alert">Your recovery code no longer works: make a new one.</p>
  {:else if live}
    <p class="status">
      On · made {day(live.createdAt)} on {live.byName}. Opened {live.opens}
      {live.opens === 1 ? 'time' : 'times'}{live.lastOpenedAt
        ? `, last ${day(live.lastOpenedAt)}`
        : ''} — your own redeems count too.
    </p>
    {#if live.reposted}
      <p class="foot">Den had lost this code and was given it again, so its count started over.</p>
    {/if}
  {:else}
    <p class="status">Off.</p>
  {/if}
  <div class="form">
    {#if phase === 1}
      <!-- Argon2id can take seconds on a slow phone (§3): say it is working, up to its timeout. -->
      <Loading label="Working…" inline />
    {:else if live}
      <Confirm
        label="Make a new code"
        question="Make a new recovery code?"
        detail="Your current code stops working."
        confirmLabel="Make a new code"
        tone="primary"
        disabled={view === undefined}
        onconfirm={() => void make()}
      />
      <Confirm
        label="Turn off"
        question="Turn off your recovery code?"
        detail="It stops opening your library."
        onconfirm={() => void off()}
      />
    {:else}
      <Button
        variant="primary"
        label="Make a recovery code"
        disabled={view === undefined}
        onclick={() => void make()}
      />
    {/if}
  </div>
  {#if live && live.opens > 0}
    <p class="foot">
      Opened more times than you expect? Turn it off, then reset the library key on your Apple TV
      under Settings › Linked devices: turning it off alone doesn’t take back a key already opened.
    </p>
  {/if}
{/if}
{#if message}<p class="status" class:bad={messageBad} role="status">
    {i18n.phrase(message)}
  </p>{/if}
<p class="foot">
  A recovery code opens your library on a new device when none of yours is at hand. It’s made and
  checked on this device; Den keeps only a sealed copy of your library key that the code opens.
</p>

<style>
  .code-screen {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px 14px;
    margin-top: 8px;
    padding: 14px 16px;
    border-radius: 12px;
    background: rgb(255 255 255 / 0.03);
  }

  .code-screen p {
    flex: 1 1 100%;
    margin: 0;
    color: var(--muted);
    font-size: 14px;
  }

  .code-screen p b {
    color: var(--fg);
  }

  .code-screen .small {
    font-size: 13px;
  }

  .code {
    font:
      700 22px/1.2 ui-monospace,
      SFMono-Regular,
      Menlo,
      Consolas,
      monospace;
    letter-spacing: 0.08em;
    overflow-wrap: anywhere;
    user-select: all;
    -webkit-user-select: all;
  }
</style>
