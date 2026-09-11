<script lang="ts">
  import { links } from './lib/links.svelte';
  import { formatCode, join, parseCode, type JoinError } from './lib/pair';

  // The TV's QR carries its code in the URL fragment, which never reaches a server; it is read once and dropped
  // from the address bar, so it isn't left in history.
  const scanned = new URLSearchParams(location.hash.slice(1)).get('pair');
  if (scanned) history.replaceState(null, '', location.pathname + location.search);
  let code = $state(formatCode(scanned ?? '').text);

  /** The empty slots behind the field: what's typed covers them one by one, the dashes stay put. */
  const MASK = '____-____-____';

  /** Regroups what was typed; deleting a dash deletes the character beside it instead, or the dash would come back. */
  function typed(event: Event & { currentTarget: HTMLInputElement }) {
    const input = event.currentTarget;
    let value = input.value;
    let caret = input.selectionStart ?? value.length;
    const kind = event instanceof InputEvent ? event.inputType : '';
    if (value.replace(/-/g, '').length === code.replace(/-/g, '').length) {
      if (kind === 'deleteContentBackward' && caret > 0) {
        value = value.slice(0, caret - 1) + value.slice(caret);
        caret -= 1;
      } else if (kind === 'deleteContentForward') {
        value = value.slice(0, caret) + value.slice(caret + 1);
      }
    }
    const next = formatCode(value, caret);
    code = next.text;
    input.value = next.text;
    input.setSelectionRange(next.caret, next.caret);
  }
  let busy = $state(false);
  let failure = $state<JoinError | null>(null);

  const messages: Record<JoinError, string> = {
    expired: 'That code has expired or doesn’t exist. Get a new one on the TV.',
    claimed: 'That code was already used. Get a new one on the TV.',
    throttled: 'Too many tries. Wait a minute and try again.',
    unreachable: 'Couldn’t reach Den. Check that this device is on your network.',
    mistyped: 'That isn’t a whole code. Check it against the TV.',
    failed: 'The TV didn’t link this device: the code didn’t match, or it wasn’t allowed. Get a new code on the TV.',
  };

  /** The twelve characters the TV shows. */
  const whole = $derived(parseCode(code) !== null);

  async function link() {
    busy = true;
    failure = null;
    const result = await join(code);
    busy = false;
    if ('error' in result) {
      failure = result.error;
      return;
    }
    const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
    const { host, libraryKey, linkKey } = result.handover;
    links.add(result.inboxKey, { name: host, libraryKey: base64(libraryKey), linkKey: base64(linkKey) });
  }

  // A scanned code starts at once: the next step is on the TV.
  if (scanned && parseCode(scanned)) void link();
</script>

<section>
  <h1>Link your Apple TV</h1>
  {#if links.moved}
    <p class="sub" role="status">{links.moved} reset its library key, so this device needs to link again.</p>
  {/if}
  <p class="sub">On the TV, open <b>Settings › Linked devices</b> and scan its code, or type it here.</p>
  <form
    onsubmit={(event) => {
      event.preventDefault();
      void link();
    }}
  >
    <div class="code">
      <span class="mask" aria-hidden="true"><span class="typed">{code}</span>{MASK.slice(code.length)}</span>
      <input
        value={code}
        oninput={typed}
        autocomplete="off"
        autocapitalize="characters"
        spellcheck="false"
        aria-label="Link code, twelve characters"
        disabled={busy}
      />
    </div>
    <button class="primary" disabled={busy || !whole}>{busy ? 'Allow this device on your TV…' : 'Link'}</button>
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

  /* The mask sizes the box and sits under the input: both share one monospace font, so each typed character
     lands on its slot. */
  .code {
    position: relative;
    justify-self: center;
    max-width: 100%;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--card);
  }

  .code:focus-within {
    border-color: var(--accent);
  }

  .mask,
  .code input {
    padding: 16px 20px;
    font: 700 24px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    letter-spacing: 0.18em;
  }

  .mask {
    display: block;
    color: var(--muted);
    white-space: pre;
  }

  .typed {
    visibility: hidden;
  }

  .code input {
    position: absolute;
    inset: 0;
    width: 100%;
    border: 0;
    background: transparent;
    color: var(--fg);
    outline: none;
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
