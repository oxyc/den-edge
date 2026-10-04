<!-- Settings › Linked devices › Recovery code (den-spec recovery-code §6): make a code, show it once, have its last group
     typed back before it goes live, and show what den-edge counts of it. The code lives in this component's memory
     only, from the moment it is made until this screen closes; leaving before confirming ends it. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import Confirm from './Confirm.svelte';
  import Loading from '../components/Loading.svelte';
  import { copyText } from '../lib/clipboard';
  import type { BrowserClock } from '../lib/clock';
  import type { Link } from '../lib/links.svelte';
  import type { LibraryLog } from '../lib/log';
  import {
    abandon,
    begin,
    confirm,
    DeriveFailed,
    deviceCouldNot,
    makingWaits,
    prepare,
    reconcile,
    recoveryContext,
    turnOff,
    type Prepared,
    type RecoveryContext,
    type RecoveryStatus,
  } from '../lib/recovery';

  let {
    link,
    log,
    clock,
  }: { link: Link; log: LibraryLog | null | undefined; clock: BrowserClock } = $props();

  const day = (at: number) =>
    new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

  /** undefined while it is read; null when den-edge couldn't be. */
  let status = $state<RecoveryStatus | null | undefined>(undefined);
  let notices = $state<string[]>([]);
  let phase = $state<'idle' | 'making' | 'show' | 'confirming' | 'lost'>('idle');
  let prepared = $state<Prepared | null>(null);
  let typed = $state('');
  let message = $state<{ text: string; bad: boolean } | null>(null);
  let copied = $state(false);
  let manual = $state(false);
  let codeEl = $state<HTMLElement>();
  let baseLive = new Set<string>();
  let finish: () => void = () => {};
  let context: RecoveryContext | null = null;

  const ctx = async () => {
    if (!log) throw new Error('no library');
    return (context ??= await recoveryContext(link.libraryKey, log, clock));
  };

  async function check() {
    if (!log) return;
    try {
      status = await reconcile(await ctx());
      if (status?.notices.length) notices = [...notices, ...status.notices];
    } catch (error) {
      console.warn('den: recovery code status could not be read', error);
      status = null;
    }
  }

  // Opening this screen reconciles (§7).
  $effect(() => {
    if (log && status === undefined) void check();
  });

  const failures = {
    full: 'Den holds too many codes for this library just now. Try again in a minute.',
    taken: 'That code collided with another. Make a new one.',
    failed: 'Couldn’t save the code. Check that this device is on your network.',
    waits: 'Available after the library update.',
  };

  async function make() {
    phase = 'making';
    message = null;
    copied = false;
    manual = false;
    try {
      const c = await ctx();
      const made = await prepare(c, link.libraryKey);
      const begun = await begin(c, made);
      if (!begun.ok) {
        phase = 'idle';
        message = { text: failures[begun.error], bad: true };
        return;
      }
      baseLive = begun.baseLive;
      finish = begun.done;
      prepared = made;
      typed = '';
      phase = 'show';
    } catch (error) {
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
    const result = await confirm(await ctx(), made, baseLive);
    if (result.ok) {
      end();
      message = { text: 'Your recovery code is on.', bad: false };
      await check();
    } else if ('lost' in result) {
      end();
      phase = 'lost';
      message = { text: result.lost, bad: true };
    } else {
      phase = 'show';
      message = {
        text: 'Couldn’t save that. Check that this device is on your network, then confirm again.',
        bad: true,
      };
    }
  }

  /** The code leaves memory: this screen no longer holds it. */
  function end() {
    finish();
    finish = () => {};
    prepared = null;
    typed = '';
    phase = 'idle';
  }

  async function cancel() {
    const made = prepared;
    end();
    if (made && context) await abandon(context, made.locator);
  }

  async function off() {
    message = null;
    if (await turnOff(await ctx())) await check();
    else message = { text: failures.failed, bad: true };
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
    if (prepared && context) void abandon(context, prepared.locator);
    finish();
  });

  const live = $derived(status?.live ?? null);
</script>

<h3>Recovery code</h3>
{#each notices as notice (notice)}<p class="status" role="status">{notice}</p>{/each}

{#if phase === 'show' || phase === 'confirming'}
  {@const made = prepared!}
  <div class="code-screen">
    <p>
      <b>Anyone with this code can open your library.</b> Write it down or keep it in a password manager.
      Den can’t show it again.
    </p>
    <b class="code" data-no-swipe bind:this={codeEl}>{made.code}</b>
    <span class="actions">
      <button type="button" class="quiet" onclick={() => void copy(made.code)}
        >{copied ? 'Copied' : 'Copy'}</button
      >
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
      <button class="primary" disabled={phase === 'confirming' || typed.trim().length < 4}
        >{phase === 'confirming' ? 'Saving…' : 'I’ve saved it'}</button
      >
      <button type="button" class="quiet" onclick={() => void cancel()}>Cancel</button>
    </form>
  </div>
{:else if phase === 'lost'}
  <span class="actions">
    <button
      type="button"
      class="quiet"
      onclick={() => {
        phase = 'idle';
        message = null;
        void check();
      }}>Close</button
    >
  </span>
{:else if !log}
  <p class="status">Your library isn’t open yet.</p>
{:else if makingWaits(log)}
  <p class="status">Available after the library update.</p>
{:else}
  {#if status === undefined}
    <p class="status" role="status">Checking your recovery code…</p>
  {:else if status === null}
    <p class="status bad" role="alert">Couldn’t reach Den to check your recovery code.</p>
  {:else if status.broken}
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
        disabled={status === undefined}
        onconfirm={() => void make()}
      />
      <Confirm
        label="Turn off"
        question="Turn off your recovery code?"
        detail="It stops opening your library."
        onconfirm={() => void off()}
      />
    {:else}
      <button
        type="button"
        class="primary"
        disabled={status === undefined}
        onclick={() => void make()}>Make a recovery code</button
      >
    {/if}
  </div>
  {#if live && live.opens > 0}
    <p class="foot">
      Opened more times than you expect? Turn it off, then reset the library key on your Apple TV
      under Settings › Linked devices: turning it off alone doesn’t take back a key already opened.
    </p>
  {/if}
{/if}
{#if message}<p class="status" class:bad={message.bad} role="status">{message.text}</p>{/if}
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
