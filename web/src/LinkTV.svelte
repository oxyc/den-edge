<script lang="ts">
  import { onMount } from 'svelte';
  import Button from './components/Button.svelte';
  import { thisDevice } from './lib/device.svelte';
  import { browserClock } from './lib/clock';
  import { links } from './lib/links.svelte';
  import {
    formatCode,
    join,
    parseCode,
    receive,
    type JoinError,
    type JoinResult,
  } from './lib/pair';
  import { guestGrants } from './lib/grants.svelte';
  import { qrCode } from './lib/qr';
  import { tvLink } from './lib/tvLink';
  import RecoveryRedeem from './components/RecoveryRedeem.svelte';
  import { currentAppPath } from './lib/runtimeUrl';

  /** Inside another screen's dialog (the assistant consent page), which says where the code comes from itself. */
  let { embedded = false }: { embedded?: boolean } = $props();

  // The TV's QR carries its code in the URL fragment, which never reaches a server; it is read once and dropped
  // from the address bar, so it isn't left in history.
  const scanned = new URLSearchParams(location.hash.slice(1)).get('pair');
  if (scanned)
    history.replaceState(
      null,
      '',
      __DEN_TV_PACKAGED__ ? currentAppPath() : location.pathname + location.search,
    );
  let code = $state(formatCode(scanned ?? '').text);

  /** The dashes behind the field, with a blank for each character still to type. */
  const MASK = '    -    -    ';

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
  const deviceId = browserClock().device;
  let receiveCode = $state<string | null>(null);
  let receiveFailure = $state<string | null>(null);
  let receiving = $state(false);
  let receiveController = new AbortController();
  const receiveAddress = $derived(
    receiveCode ? tvLink(__DEN_TV_API_ORIGIN__ || location.origin, receiveCode) : null,
  );
  const receiveQR = $derived(receiveAddress ? qrCode(receiveAddress) : null);

  const messages: Record<JoinError, string> = {
    expired: 'That code has expired or doesn’t exist. Get a new one on the TV.',
    claimed: 'That code was already used. Get a new one on the TV.',
    throttled: 'Too many tries. Wait a minute and try again.',
    unreachable: 'Couldn’t reach Den. Check that this device is on your network.',
    mistyped: 'That isn’t a whole code. Check it against the TV.',
    failed:
      'The TV didn’t link this device: the code didn’t match, or it wasn’t allowed. Get a new code on the TV.',
    insecure:
      'Linking needs a secure connection. Open Den over https (not a plain http address) and try again.',
  };

  /** The twelve characters the TV shows. */
  const whole = $derived(parseCode(code) !== null);

  async function keep(result: Extract<JoinResult, { handover: unknown }>): Promise<boolean> {
    const ticket = result.handover.grantTicket;
    if (ticket) {
      const redeemed = await guestGrants.redeemTicket(ticket);
      if ('failure' in redeemed) {
        receiveFailure =
          redeemed.failure === 'full'
            ? `${redeemed.host} needs to allow another device before this TV can use the shared Den.`
            : redeemed.failure === 'invalid'
              ? 'The shared-access ticket expired. Show a new QR and scan it again.'
              : 'Couldn’t add shared access to this TV. Check its connection and try again.';
        return false;
      }
    }
    const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
    const { host, hostDeviceId, libraryKey, linkKey } = result.handover;
    links.add(result.inboxKey, {
      name: host,
      libraryKey: base64(libraryKey),
      linkKey: base64(linkKey),
      ...(hostDeviceId ? { deviceId: hostDeviceId } : {}),
    });
    return true;
  }

  async function showTVLink() {
    receiveController.abort();
    receiveController = new AbortController();
    receiveCode = null;
    receiveFailure = null;
    receiving = true;
    const result = await receive({
      label: thisDevice.name,
      deviceId,
      signal: receiveController.signal,
      onCode: (next) => (receiveCode = next),
    });
    receiving = false;
    if ('error' in result) {
      if (!receiveController.signal.aborted)
        receiveFailure =
          result.error === 'insecure'
            ? 'Linking needs a secure HTTPS connection.'
            : result.error === 'throttled'
              ? 'Too many links were started. Wait a minute and try again.'
              : 'That link didn’t finish. Show a new QR and try again.';
      return;
    }
    await keep(result);
  }

  onMount(() => {
    if (__DEN_TV__) void showTVLink();
    return () => receiveController.abort();
  });

  async function link() {
    busy = true;
    failure = null;
    const result = await join(code, { label: thisDevice.name, deviceId });
    busy = false;
    if ('error' in result) {
      failure = result.error;
      return;
    }
    await keep(result);
  }

  // A scanned code starts at once: the next step is on the TV.
  if (scanned && parseCode(scanned)) void link();
</script>

<section class:embedded>
  {#if !embedded}<h1>{__DEN_TV__ ? 'Open your Den library' : 'Link your Apple TV'}</h1>{/if}
  {#if links.moved}
    <p class="sub" role="status">
      The library linked through {links.moved} got a new key, so this device needs to link again.
    </p>
  {/if}
  {#if !embedded}
    <p class="sub">
      {#if __DEN_TV__}
        Scan this code with your phone’s camera, then confirm which Den this TV should open.
      {:else}
        On the TV, open <b>Settings › Linked devices</b> and scan its code, or type it here.
      {/if}
    </p>
  {/if}
  {#if __DEN_TV__}
    <div class="tv-link" aria-live="polite">
      {#if receiveQR && receiveCode}
        <svg
          class="qr"
          viewBox="-2 -2 {receiveQR.size + 4} {receiveQR.size + 4}"
          role="img"
          aria-label="QR code to link this TV"
          shape-rendering="crispEdges"
        >
          <rect x="-2" y="-2" width={receiveQR.size + 4} height={receiveQR.size + 4} fill="#fff" />
          <path d={receiveQR.path} fill="#000" />
        </svg>
        <b class="shown-code">{formatCode(receiveCode).text}</b>
        <p class="sub">Any camera app can open it. The code works once, for ten minutes.</p>
      {:else if receiving}
        <p class="sub">Making a secure link…</p>
      {/if}
      {#if receiveFailure}
        <p class="error" role="alert">{receiveFailure}</p>
        <Button variant="primary" label="Show a new QR" onclick={() => void showTVLink()} />
      {/if}
    </div>
    <p class="alternative">Or enter a code from a device that already has your library:</p>
  {/if}
  <form
    onsubmit={(event) => {
      event.preventDefault();
      void link();
    }}
  >
    <div class="code">
      <span class="mask" aria-hidden="true"
        ><span class="typed">{code}</span>{MASK.slice(code.length)}</span
      >
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
    <label class="name">
      <span
        >{__DEN_TV__
          ? 'Your other device will see this TV as'
          : 'The TV will ask to allow this device as'}</span
      >
      <input
        value={thisDevice.chosen}
        placeholder={thisDevice.guess}
        oninput={(event) => thisDevice.rename(event.currentTarget.value)}
        autocomplete="off"
        maxlength="40"
        aria-label="This device’s name"
        disabled={busy}
      />
    </label>
    <Button
      type="submit"
      variant="primary"
      size="large"
      label={busy ? 'Allow this device on your TV…' : 'Link'}
      disabled={busy || !whole}
    />
  </form>
  {#if failure}
    <p class="error" role="alert">{messages[failure]}</p>
  {/if}
  {#if !embedded}
    <!-- No TV at hand, or a new Apple ID: the code opens the library from den-edge alone (recovery-code §8). -->
    <details class="recovery">
      <summary>Open with a recovery code</summary>
      <RecoveryRedeem onopen={(key) => (links.addRecovered(key), true)} />
    </details>
  {/if}
  <!-- Someone who only wants to look around should not be stopped by a pairing step. Dismissing is
       remembered, so the invitation belongs to a first visit; pairing stays under Settings afterwards. -->
  {#if !embedded}
    <Button
      class="browse"
      variant="tertiary"
      label="Look around instead"
      onclick={() => links.browse()}
    />
  {/if}
</section>

<style>
  section {
    max-width: 420px;
    margin: 8vh auto 0;
    text-align: center;
  }

  section.embedded {
    margin: 0;
  }

  h1 {
    margin: 0 0 8px;
    font-size: 28px;
  }

  .sub {
    margin: 0 0 24px;
    color: var(--muted);
  }

  .error {
    color: var(--danger);
  }

  .tv-link {
    display: grid;
    justify-items: center;
    gap: 12px;
    margin-bottom: 24px;
  }

  .tv-link .sub,
  .tv-link .error {
    margin: 0;
  }

  .qr {
    width: min(240px, 56vw);
    padding: 10px;
    border-radius: 12px;
    background: #fff;
  }

  .shown-code {
    font:
      700 20px/1.2 ui-monospace,
      SFMono-Regular,
      Menlo,
      Consolas,
      monospace;
    letter-spacing: 0.12em;
  }

  .alternative {
    margin: 0 0 12px;
    color: var(--muted);
    font-size: 14px;
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
    font:
      700 24px/1.2 ui-monospace,
      SFMono-Regular,
      Menlo,
      Consolas,
      monospace;
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

  /* Two phones of the same make guess the same name, and the TV's list would show two of it. */
  .name {
    display: grid;
    gap: 6px;
  }

  .name span {
    color: var(--muted);
    font-size: 14px;
  }

  .name input {
    padding: 12px 16px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--card);
    color: var(--fg);
    font: inherit;
    text-align: center;
    outline: none;
  }

  .name input:focus-visible {
    border-color: var(--accent);
  }

  .recovery {
    margin-top: 24px;
    text-align: left;
  }

  .recovery summary {
    color: var(--muted);
    text-align: center;
    cursor: pointer;
  }

  :global(.browse) {
    margin-top: 20px;
    color: var(--muted);
  }
</style>
