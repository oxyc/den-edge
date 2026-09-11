<script lang="ts">
  import { claimCode, type ClaimError } from './lib/edge';
  import { links } from './lib/links.svelte';

  // The TV's link QR carries the code, so a scan arrives ready to link.
  let code = $state(new URLSearchParams(location.search).get('code')?.toUpperCase() ?? '');
  let busy = $state(false);
  let failure = $state<ClaimError | null>(null);

  const messages: Record<ClaimError, string> = {
    expired: 'That code has expired or doesn’t exist. Get a new one on the TV.',
    claimed: 'That code was already used. Get a new one on the TV.',
    throttled: 'Too many tries. Wait a minute and try again.',
    unreachable: 'Couldn’t reach Den. Check that this device is on your network.',
  };

  async function link(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    failure = null;
    const result = await claimCode(code);
    busy = false;
    if ('error' in result) {
      failure = result.error;
      return;
    }
    links.add(result.inboxKey);
  }
</script>

<section>
  <h1>Link your Apple TV</h1>
  <p class="sub">On the TV, open <b>Settings › Linked devices</b> and enter the code it shows.</p>
  <form onsubmit={link}>
    <input
      class="code"
      bind:value={code}
      maxlength="6"
      autocomplete="off"
      autocapitalize="characters"
      spellcheck="false"
      placeholder="XXXXXX"
      aria-label="Link code"
    />
    <button class="primary" disabled={busy || code.trim().length !== 6}>{busy ? 'Linking…' : 'Link'}</button>
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
    font-size: 24px;
    font-weight: 700;
    letter-spacing: 0.4em;
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
