<!-- "Open with a recovery code" (den-spec recovery-code §8): a pasted or typed code, read and checked here, then the
     library it opens. The code is held only in this field until it is opened. -->
<script lang="ts">
  import Loading from './Loading.svelte';
  import { redeem, redeemMessages } from '../lib/recovery';
  import Button from './Button.svelte';

  let {
    question,
    onopen,
  }: {
    /** Said before a library already open here is left for the recovered one; none asks nothing. */
    question?: string;
    /** Opens the recovered library (base64 key). False when it couldn't. */
    onopen: (libraryKey: string) => Promise<boolean> | boolean;
  } = $props();

  let code = $state('');
  let busy = $state(false);
  let problem = $state<string | null>(null);
  /** The key a code opened, waiting for the person to go on. */
  let opened = $state<string | null>(null);

  async function open() {
    busy = true;
    problem = null;
    const result = await redeem(code);
    busy = false;
    if ('error' in result) {
      problem =
        result.error === 'rate_limited' && result.retryAfter
          ? `Too many tries. Try again in ${Math.ceil(result.retryAfter / 60)} min.`
          : redeemMessages[result.error];
      return;
    }
    code = '';
    opened = result.libraryKey;
  }

  async function go() {
    if (!opened) return;
    busy = true;
    const done = await onopen(opened);
    busy = false;
    if (done) opened = null;
    else problem = 'Couldn’t open that library here. Check that this device is on your network.';
  }
</script>

{#if opened}
  <div class="opened" role="status">
    <p>
      <b>Your library is open.</b> Your recovery code still works. If anyone else may have seen it, make
      a new one in Settings › Linked devices.
    </p>
    {#if question}<p>{question}</p>{/if}
    <Button
      variant="primary"
      label={busy ? 'Opening…' : 'Open my library'}
      {busy}
      onclick={() => void go()}
    />
  </div>
{:else}
  <form
    onsubmit={(event) => {
      event.preventDefault();
      void open();
    }}
  >
    <input
      autocomplete="off"
      autocapitalize="characters"
      spellcheck="false"
      placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
      aria-label="Recovery code"
      disabled={busy}
      bind:value={code}
    />
    <Button
      type="submit"
      variant="primary"
      label="Open with code"
      disabled={busy || !code.trim()}
    />
  </form>
  <!-- Argon2id can take seconds on a slow phone (§3): say it is working, up to its timeout. -->
  {#if busy}<Loading label="Working…" inline />{/if}
{/if}
{#if problem}<p class="bad" role="alert">{problem}</p>{/if}

<style>
  /* Its own look, as Settings draws its fields, for the link screen too, which has none of Settings' styles. */
  form {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 12px;
  }

  input {
    flex: 1 1 240px;
    min-width: 0;
    min-height: 44px;
    padding: 10px 14px;
    border: 1px solid transparent;
    border-radius: 10px;
    background: rgb(255 255 255 / 0.06);
    color: var(--fg);
    font:
      16px ui-monospace,
      SFMono-Regular,
      Menlo,
      Consolas,
      monospace;
  }

  input:focus {
    border-color: var(--accent);
    outline: none;
  }

  .bad {
    margin: 10px 0 0;
    color: var(--danger);
    font-size: 14px;
  }

  .opened {
    display: grid;
    gap: 10px;
    margin-top: 12px;
  }

  .opened p {
    margin: 0;
    color: var(--muted);
    font-size: 14px;
  }

  .opened b {
    color: var(--fg);
  }
</style>
