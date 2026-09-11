<script lang="ts">
  import { claimCode, type ClaimError } from './lib/edge';
  import { links } from './lib/links.svelte';
  import { join, parseCode, type JoinError } from './lib/pair';

  // The TV's QR carries its code in the URL fragment, which never reaches a server; it is read once and dropped
  // from the address bar, so it isn't left in history. An older TV's QR carries a six-character code in ?code=.
  const scanned = new URLSearchParams(location.hash.slice(1)).get('pair');
  if (scanned) history.replaceState(null, '', location.pathname + location.search);
  let code = $state((scanned ?? new URLSearchParams(location.search).get('code') ?? '').toUpperCase());
  let busy = $state(false);
  let failure = $state<ClaimError | JoinError | null>(null);

  const messages: Record<ClaimError | JoinError, string> = {
    expired: 'That code has expired or doesn’t exist. Get a new one on the TV.',
    claimed: 'That code was already used. Get a new one on the TV.',
    throttled: 'Too many tries. Wait a minute and try again.',
    unreachable: 'Couldn’t reach Den. Check that this device is on your network.',
    mistyped: 'That isn’t a whole code. Check it against the TV.',
    failed: 'The TV didn’t link this device: the code didn’t match, or it wasn’t allowed. Get a new code on the TV.',
  };

  /** A TV that pairs shows twelve characters; an older one shows six. */
  const pairing = $derived(parseCode(code) !== null);
  const older = $derived(/^[A-Z0-9]{6}$/i.test(code.trim()));

  async function link() {
    busy = true;
    failure = null;
    if (pairing) {
      const result = await join(code);
      busy = false;
      if ('error' in result) {
        failure = result.error;
        return;
      }
      const libraryKey = btoa(String.fromCharCode(...result.handover.libraryKey));
      links.add(result.inboxKey, { name: result.handover.host, libraryKey });
      return;
    }
    const result = await claimCode(code);
    busy = false;
    if ('error' in result) {
      failure = result.error;
      return;
    }
    links.add(result.inboxKey);
  }

  // A scanned code starts at once: the next step is on the TV.
  if (scanned && parseCode(scanned)) void link();
</script>

<section>
  <h1>Link your Apple TV</h1>
  <p class="sub">On the TV, open <b>Settings › Linked devices</b> and scan its code, or type it here.</p>
  <form
    onsubmit={(event) => {
      event.preventDefault();
      void link();
    }}
  >
    <input
      class="code"
      bind:value={code}
      maxlength="16"
      autocomplete="off"
      autocapitalize="characters"
      spellcheck="false"
      placeholder="ABCD-EFGH-JKLM"
      aria-label="Link code"
      disabled={busy}
    />
    <button class="primary" disabled={busy || !(pairing || older)}>
      {busy ? (pairing ? 'Allow this device on your TV…' : 'Linking…') : 'Link'}
    </button>
  </form>
  {#if failure}
    <p class="error" role="alert">{messages[failure]}</p>
  {/if}
</section>

<style>
  section {
    max-width: 420px;
    margin: 8vh auto 0;
    text-align: center;
  }

  h1 {
    margin: 0 0 8px;
    font-size: 28px;
  }

  .sub {
    margin: 0 0 24px;
    color: var(--muted);
  }

  form {
    display: grid;
    gap: 12px;
  }

  .code {
    width: 100%;
    padding: 16px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--card);
    color: var(--fg);
    font-size: 22px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-align: center;
    text-transform: uppercase;
    outline: none;
  }

  .code:focus-visible {
    border-color: var(--accent);
  }

  .primary {
    padding: 14px;
    border: 0;
    border-radius: 999px;
    background: var(--accent);
    color: #fff;
    font-weight: 600;
    cursor: pointer;
  }

  .primary:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .error {
    color: var(--danger);
  }
</style>
