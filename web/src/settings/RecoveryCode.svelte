<!-- Settings › Advanced › Recovery code (den-spec recovery-code §6): make a code, show it once, have its last group
     typed back before it goes live, and show what den-edge counts of it. The code lives in this component's memory
     only, from the moment it is made until this screen closes; leaving before confirming ends it. -->
<script lang="ts">
  import Button from '../components/Button.svelte';
  import { onMount } from 'svelte';
  import Confirm from './Confirm.svelte';
  import Loading from '../components/Loading.svelte';
  import { copyText } from '../lib/clipboard';
  import { derive, DeriveFailed, deviceCouldNot, newCode } from '../lib/recovery';
  import type { RecoveryView } from '../lib/libraryServiceProtocol';
  import type { Immutable } from '../lib/libraryModel.svelte';
  import { i18n } from '../lib/i18n.svelte';
  import type { RecoveryAbandonOutcome, RecoveryConfirmationOutcome } from './recoveryConfirmation';

  interface PreparedCode {
    code: string;
    locator: string;
    createdAt: number;
    lastGroup: string;
  }

  interface NewCodeMaterial {
    code: string;
    locator: string;
    wrapKey: Uint8Array<ArrayBuffer>;
  }

  const makeCodeMaterial = async (): Promise<NewCodeMaterial> => {
    const made = await newCode();
    const derived = await derive(made.data, { op: 'make' });
    return { code: made.code, locator: derived.locator, wrapKey: derived.wrapKey };
  };

  const toBase64url = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

  let {
    view,
    ready,
    seal,
    begin,
    confirm,
    abandon,
    disable,
    makeCode = makeCodeMaterial,
  }: {
    view?: Immutable<RecoveryView>;
    ready: boolean;
    seal: (locator: string, wrapKey: string, createdAt: number) => Promise<string>;
    begin: (locator: string, sealed: string, createdAt: number) => Promise<string>;
    confirm: (locator: string, operationId: string) => Promise<RecoveryConfirmationOutcome>;
    abandon: (locator: string, operationId: string) => Promise<RecoveryAbandonOutcome>;
    disable: () => Promise<boolean>;
    /** Controlled material source for the real component's browser race fixture. */
    makeCode?: () => Promise<NewCodeMaterial>;
  } = $props();

  const day = (at: number) =>
    new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

  let phase = $state<'idle' | 'making' | 'show' | 'confirming' | 'cleanup' | 'lost'>('idle');
  let prepared = $state<PreparedCode | null>(null);
  let typed = $state('');
  let message = $state<{ text: string; bad: boolean } | null>(null);
  let copied = $state(false);
  let manual = $state(false);
  let codeEl = $state<HTMLElement>();
  let attempt = 0;
  let presentation = 0;
  let confirming: { presentation: number; locator: string; operationId: string } | null = null;
  let abandoning = $state.raw<{ presentation: number; locator: string } | null>(null);
  let pendingCleanup = $state<string | null>(null);

  const operationId = () =>
    [...crypto.getRandomValues(new Uint8Array(16))]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('');

  const failures = {
    full: 'Den holds too many codes for this library just now. Try again in a minute.',
    taken: 'That code collided with another. Make a new one.',
    failed: 'Couldn’t save the code. Check that this device is on your network.',
    waits: 'Available after the library update.',
  };

  async function make() {
    const current = ++attempt;
    phase = 'making';
    message = null;
    copied = false;
    manual = false;
    try {
      const made = await makeCode();
      if (current !== attempt) {
        made.wrapKey.fill(0);
        return;
      }
      const createdAt = Date.now();
      let sealed: string;
      try {
        sealed = await seal(made.locator, toBase64url(made.wrapKey), createdAt);
      } finally {
        made.wrapKey.fill(0);
      }
      const outcome = await begin(made.locator, sealed, createdAt);
      if (current !== attempt) {
        if (outcome === 'begun') await abandon(made.locator, operationId());
        return;
      }
      if (outcome !== 'begun') {
        phase = 'idle';
        message = {
          text: failures[outcome as keyof typeof failures] ?? failures.failed,
          bad: true,
        };
        return;
      }
      prepared = {
        code: made.code,
        locator: made.locator,
        createdAt,
        lastGroup: made.code.slice(-4),
      };
      typed = '';
      phase = 'show';
    } catch (error) {
      if (current !== attempt) return;
      console.warn('den: a recovery code could not be made', error);
      phase = 'idle';
      message = {
        text: error instanceof DeriveFailed ? deviceCouldNot.make : failures.failed,
        bad: true,
      };
    }
  }

  async function save() {
    const made = prepared;
    if (!made) return;
    if (typed.replace(/[\s-]/g, '').toUpperCase() !== made.lastGroup) {
      message = {
        text: 'That isn’t the last group of your code. Check what you wrote down.',
        bad: true,
      };
      return;
    }
    phase = 'confirming';
    message = null;
    const owner = {
      presentation: ++presentation,
      locator: made.locator,
      operationId: operationId(),
    };
    confirming = owner;
    const outcome = await confirm(made.locator, owner.operationId).catch(
      (): RecoveryConfirmationOutcome => ({ state: 'pending' }),
    );
    if (confirming !== owner || presentation !== owner.presentation) {
      // Teardown forgot the secret while this request owned the locator. A pending/unknown answer still needs the
      // exact authority's serialized, pending-only cleanup; a committed or lost answer is already final.
      if (outcome.state === 'pending') void abandon(owner.locator, operationId());
      return;
    }
    confirming = null;
    if (outcome.state === 'committed') {
      end();
      message = { text: 'Your recovery code is on.', bad: false };
    } else if (outcome.state === 'lost') {
      end();
      phase = 'lost';
      message = { text: 'That pending recovery code was replaced. Make a new one.', bad: true };
    } else if (outcome.state === 'pending') {
      phase = 'show';
      message = {
        text: 'Couldn’t save that. Check that this device is on your network, then confirm again.',
        bad: true,
      };
    } else {
      end();
    }
  }

  /** The code leaves memory: this screen no longer holds it. */
  function end() {
    prepared = null;
    typed = '';
    phase = 'idle';
  }

  async function cancel() {
    attempt++;
    presentation++;
    const made = prepared;
    end();
    if (made) await cancelPending(made.locator);
  }

  async function cancelPending(locator: string) {
    const owner = { presentation: ++presentation, locator };
    abandoning = owner;
    pendingCleanup = locator;
    phase = 'cleanup';
    message = null;
    const outcome = await abandon(locator, operationId()).catch((): RecoveryAbandonOutcome => ({
      state: 'pending',
    }));
    if (abandoning !== owner || presentation !== owner.presentation) return;
    abandoning = null;
    if (outcome.state === 'pending') {
      message = {
        text: 'Couldn’t cancel that recovery code setup. Check your connection and try again.',
        bad: true,
      };
      return;
    }
    pendingCleanup = null;
    phase = outcome.state === 'lost' ? 'lost' : 'idle';
    if (outcome.state === 'committed')
      message = { text: 'Your recovery code was already saved and remains on.', bad: false };
    else if (outcome.state === 'lost')
      message = { text: 'That pending recovery code was replaced. Make a new one.', bad: true };
  }

  async function off() {
    message = null;
    if (!(await disable())) message = { text: failures.failed, bad: true };
  }

  /**
   * Onto the clipboard, and nothing more: no clear is attempted. A browser lets a page read the clipboard (which a
   * clear only if it still holds the code needs) only inside a gesture, and a blind clear would destroy whatever the
   * person copied since (§6). The page asks them to clear it themselves.
   */
  async function copy(code: string) {
    const result = await copyText(code, () => getSelection()?.selectAllChildren(codeEl!));
    copied = result === 'copied';
    manual = result === 'manual';
  }

  // Leaving with a code shown and not confirmed ends it; a closed tab leaves that to the next reconcile.
  onMount(() => () => {
    attempt++;
    presentation++;
    const made = prepared;
    const cleanup = pendingCleanup;
    const confirmationOwns = !!confirming && confirming.locator === made?.locator;
    const abandonmentOwns = !!abandoning && abandoning.locator === (made?.locator ?? cleanup);
    confirming = null;
    abandoning = null;
    end();
    pendingCleanup = null;
    if (!confirmationOwns && !abandonmentOwns && (made || cleanup))
      void abandon((made ?? { locator: cleanup! }).locator, operationId());
  });

  const live = $derived(view?.live ?? null);
</script>

<h3>Recovery code</h3>
{#each view?.notices ?? [] as notice (notice)}<p class="status" role="status">
    {i18n.phrase(notice)}
  </p>{/each}

{#if phase === 'show' || phase === 'confirming'}
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
        label={copied ? 'Copied' : 'Copy'}
        onclick={() => void copy(made.code)}
      />
    </span>
    {#if manual}<p class="status" role="status">Select and copy the code.</p>{/if}
    <p class="small" role="status">
      {copied ? 'Copied to your clipboard. ' : ''}Clipboard history and your system’s clipboard sync
      can carry a copied code to other devices. Once the code is saved, copy something else to clear
      it.
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
        label={phase === 'confirming' ? 'Saving…' : 'I’ve saved it'}
        disabled={phase === 'confirming' || typed.trim().length < 4}
      />
      <Button
        variant="secondary"
        label="Cancel"
        disabled={phase === 'confirming'}
        onclick={() => void cancel()}
      />
    </form>
  </div>
{:else if phase === 'cleanup'}
  <span class="actions">
    <Button
      variant="secondary"
      label="Try again"
      disabled={abandoning !== null}
      onclick={() => pendingCleanup && void cancelPending(pendingCleanup)}
    />
  </span>
{:else if phase === 'lost'}
  <span class="actions">
    <Button
      variant="secondary"
      label="Close"
      onclick={() => {
        phase = 'idle';
        message = null;
      }}
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
    {#if phase === 'making'}
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
{#if message}<p class="status" class:bad={message.bad} role="status">
    {i18n.phrase(message.text)}
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
