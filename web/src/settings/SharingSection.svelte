<!-- Settings › Sharing: lending your addons to a guest, and using addons lent to you. A guest gets an invite code from
     the owner; they are not a member of the owner's library and never see its addons, keys or watchlist — den-edge
     holds the owner's installs and the guest's browser only ever holds a secret of its own (`grants.ts`). What a guest
     holds lives in this browser (`grants.svelte.ts`), never in the library. -->
<script lang="ts">
  import { untrack } from 'svelte';
  import CheckGrid from './CheckGrid.svelte';
  import Confirm from './Confirm.svelte';
  import Select from './Select.svelte';
  import SettingRow from './SettingRow.svelte';
  import SettingsSection from './SettingsSection.svelte';
  import {
    cappedCodeExpiry,
    createGrant,
    DAY,
    DEFAULT_REDEEM_DAYS,
    GRANT_ADDONS,
    inviteLink,
    keepUploaded,
    listGrants,
    reuploadInstalls,
    revokeGrant,
    timeLeft,
    updateGrant,
    type Grant,
    type GrantAddon,
    type GrantChange,
    type Reply,
  } from '../lib/grants';
  import { guestGrants, type RedeemFailure } from '../lib/grants.svelte';
  import type { Link } from '../lib/links.svelte';
  import { libraryCredentialId } from '../lib/relayFetch';
  import type { Routes } from '../lib/routes';
  import { hostedInstalls } from '../lib/scout';

  let {
    link,
    plugins,
    routes,
    ready,
  }: {
    /** Null for a browser using its own library: it proves no membership, so it has nothing to lend. */
    link: Link | null;
    /** The library's own plugins, which a grant's installs come from. */
    plugins: string[];
    routes: Routes;
    /** The library is open, and with it the membership proof the host routes need. */
    ready: boolean;
  } = $props();

  const NAMES: Record<GrantAddon, { label: string; role: string }> = {
    scout: { label: 'Den Scout', role: 'Streams' },
    atlas: { label: 'Den Atlas', role: 'Discovery' },
    reel: { label: 'Den Reel', role: 'Trailers' },
    subtitles: { label: 'Den Subtitles', role: 'Subtitles' },
  };
  const day = (at: number) =>
    new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

  // The host's side.
  const installs = $derived(hostedInstalls(plugins, routes));
  let grants = $state<Grant[] | null>(null);
  let problem = $state<string | null>(null);
  let working = $state(false);
  let name = $state('');
  let picked = $state<Set<GrantAddon>>(new Set(GRANT_ADDONS));
  let trial = $state<'none' | '7' | '30' | 'custom'>('none');
  let customDays = $state(14);
  let redeemBy = $state(DEFAULT_REDEEM_DAYS);
  let devices = $state(1);
  let created = $state<{ name: string; code: string } | null>(null);
  let copied = $state<string | null>(null);
  let renaming = $state<{ gid: string; name: string } | null>(null);

  const offered = $derived(GRANT_ADDONS.filter((addon) => installs[addon]));
  const chosen = $derived(offered.filter((addon) => picked.has(addon)));
  const clamp = (n: number, low: number, high: number) =>
    Math.min(high, Math.max(low, Math.round(Number.isFinite(n) ? n : low)));

  const failures: Record<string, string> = {
    too_many_grants: 'You already have 10 guests. Revoke one first.',
    bad_request: 'den-edge didn’t accept that. Check the name and the choices.',
    unreachable: 'Couldn’t reach Den. Check that this device is on your network.',
  };
  const said = (reply: Extract<Reply<unknown>, { ok: false }>) =>
    failures[reply.error] ?? 'That didn’t work. Try again in a moment.';

  async function refresh() {
    const id = libraryCredentialId();
    if (!id) return;
    const listed = await listGrants(id);
    if (!listed.ok) {
      problem = said(listed);
      return;
    }
    problem = null;
    grants = listed.value;
    // The plugin list may have changed since the escrow was made: what den-edge holds follows it.
    await reuploadInstalls(id, listed.value, installs);
  }

  // Listed once the library is open, and again whenever what would be escrowed changes.
  $effect(() => {
    void JSON.stringify(installs);
    if (ready && link) untrack(() => void refresh());
  });

  async function invite() {
    const id = libraryCredentialId();
    if (!id || !name.trim() || !chosen.length) return;
    working = true;
    problem = null;
    const picks = Object.fromEntries(chosen.map((addon) => [addon, installs[addon]]));
    const reply = await createGrant(id, {
      name: name.trim(),
      addons: chosen,
      installs: picks,
      // Left out at the default, so den-edge's own clock sets it; a chosen one stays under its 90-day limit even
      // when this browser's clock runs ahead.
      ...(redeemBy === DEFAULT_REDEEM_DAYS
        ? {}
        : { codeExpiresAt: cappedCodeExpiry(Date.now(), clamp(redeemBy, 1, 89) * DAY) }),
      devices: clamp(devices, 1, 5),
      ...(trial === 'none'
        ? {}
        : { accessDays: trial === 'custom' ? clamp(customDays, 1, 365) : Number(trial) }),
    });
    working = false;
    if (!reply.ok) {
      problem = said(reply);
      return;
    }
    await keepUploaded(reply.value.grant.gid, installs, chosen);
    created = { name: reply.value.grant.name, code: reply.value.code };
    name = '';
    grants = [...(grants ?? []), reply.value.grant];
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = text;
    } catch {
      // No clipboard here: the text is still on screen to copy by hand.
      copied = null;
    }
  }

  async function change(grant: Grant, patch: GrantChange) {
    const id = libraryCredentialId();
    if (!id) return;
    working = true;
    problem = null;
    const reply = await updateGrant(id, grant.gid, patch);
    working = false;
    if (!reply.ok) {
      problem = said(reply);
      return;
    }
    grants = (grants ?? []).map((g) => (g.gid === grant.gid ? reply.value : g));
    renaming = null;
  }

  /** Give more time: to redeem the code while it is unused, and to watch once it is. */
  function extend(grant: Grant, days: number) {
    const now = Date.now();
    if (grant.redeemedAt === null) {
      const from = Math.max(now, grant.codeExpiresAt);
      void change(grant, { codeExpiresAt: cappedCodeExpiry(now, from + days * DAY - now) });
    } else {
      void change(grant, { accessUntil: Math.max(now, grant.expiresAt ?? now) + days * DAY });
    }
  }

  async function revoke(grant: Grant) {
    const id = libraryCredentialId();
    if (!id) return;
    const reply = await revokeGrant(id, grant.gid);
    if (!reply.ok) {
      problem = said(reply);
      return;
    }
    grants = (grants ?? []).map((g) => (g.gid === grant.gid ? { ...g, status: 'revoked' } : g));
  }

  const standing = (grant: Grant): string => {
    const parts: string[] = [];
    if (grant.status === 'invited')
      parts.push(`Not used yet · code good for ${timeLeft(grant.codeExpiresAt)}`);
    else if (grant.status === 'active')
      parts.push(
        grant.expiresAt === null
          ? 'Active · no end date'
          : `Active · ends in ${timeLeft(grant.expiresAt)}`,
      );
    else parts.push(grant.status === 'revoked' ? 'Revoked' : 'Expired');
    if (grant.lastUsedAt) parts.push(`last used ${day(grant.lastUsedAt)}`);
    return parts.join(' · ');
  };

  // The guest's side.
  let pasted = $state('');
  let redeeming = $state(false);
  let redeemNote = $state<{ text: string; bad: boolean } | null>(null);
  const redeemFailures: Record<RedeemFailure, string> = {
    malformed: 'That isn’t an invite. Paste the code, or the whole link you were sent.',
    invalid:
      'That invite didn’t work. It may have expired, been used up or been withdrawn: ask for a new one.',
    throttled: 'Too many tries. Wait a minute and try again.',
    unreachable: 'Couldn’t reach Den. Check that this device is on your network.',
  };

  async function accept() {
    redeeming = true;
    redeemNote = null;
    const result = await guestGrants.redeem(pasted);
    redeeming = false;
    if (typeof result === 'string') {
      redeemNote = { text: redeemFailures[result], bad: true };
      return;
    }
    pasted = '';
    redeemNote = { text: `You can now use ${result.name}’s addons.`, bad: false };
  }

  const held = $derived(guestGrants.list);
  const accessLine = (grant: (typeof held)[number]) =>
    grant.ended
      ? `Your access to ${grant.name} ended`
      : grant.expiresAt === null
        ? 'No end date'
        : `Access ends in ${timeLeft(grant.expiresAt)}`;
</script>

<SettingsSection id="sharing" title="Sharing">
  <SettingRow
    id="invite-guest"
    label="Invite a guest"
    detail="Lend your addons"
    value={grants?.length ? `${grants.length} invited` : ''}
  >
    {#if !link}
      <p class="status">
        Your addons live in your Apple TV’s library. Link this browser to it under Connections, and
        you can invite guests from here.
      </p>
    {:else}
      {#if created}
        {@const address = inviteLink(location.origin, created.code)}
        {@const code = created.code}
        <div class="made" role="status">
          <p>
            <b>{created.name}’s invite.</b> Send them this link, or the code to paste under Settings ›
            Sharing. It is shown once.
          </p>
          <span class="copy">
            <input class="field mono" readonly aria-label="Invite link" value={address} />
            <button type="button" class="quiet" onclick={() => void copy(address)}
              >{copied === address ? 'Copied' : 'Copy link'}</button
            >
          </span>
          <span class="copy">
            <input class="field mono" readonly aria-label="Invite code" value={code} />
            <button type="button" class="quiet" onclick={() => void copy(code)}
              >{copied === code ? 'Copied' : 'Copy code'}</button
            >
          </span>
          <button type="button" class="quiet" onclick={() => (created = null)}>Done</button>
        </div>
      {/if}

      <h3>New invite</h3>
      <form
        class="form"
        onsubmit={(event) => {
          event.preventDefault();
          void invite();
        }}
      >
        <input
          class="field"
          autocomplete="off"
          maxlength="60"
          placeholder="Who is it for?"
          aria-label="Guest’s name"
          bind:value={name}
        />
        <div class="wide">
          <CheckGrid
            legend="Addons to share"
            options={GRANT_ADDONS.map((addon) => ({
              value: addon,
              label: NAMES[addon].label,
              note: installs[addon] ? NAMES[addon].role : `${NAMES[addon].role} · not installed`,
              disabled: !installs[addon],
            }))}
            checked={(addon) => picked.has(addon) && !!installs[addon]}
            onchange={(addon, on) => {
              const next = new Set(picked);
              if (on) next.add(addon);
              else next.delete(addon);
              picked = next;
            }}
          />
        </div>
        <label class="labelled"
          >Access lasts
          <Select
            boxed
            label="How long access lasts"
            value={trial}
            options={[
              { value: 'none', label: 'Until you end it' },
              { value: '7', label: '7 days from first use' },
              { value: '30', label: '30 days from first use' },
              { value: 'custom', label: 'A number of days…' },
            ]}
            onchange={(value) => (trial = value as typeof trial)}
          />
        </label>
        {#if trial === 'custom'}
          <label class="labelled"
            >Days
            <input class="field" type="number" min="1" max="365" bind:value={customDays} />
          </label>
        {/if}
        <label class="labelled"
          >Redeem within (days)
          <input class="field" type="number" min="1" max="89" bind:value={redeemBy} />
        </label>
        <label class="labelled"
          >Devices
          <input class="field" type="number" min="1" max="5" bind:value={devices} />
        </label>
        <button class="primary" disabled={!ready || working || !name.trim() || !chosen.length}
          >Create invite</button
        >
      </form>
      {#if !offered.length}
        <p class="status">
          None of your plugins is a Den addon this page can share. Add Den Scout under Plugins
          first.
        </p>
      {/if}
      {#if problem}<p class="status bad" role="alert">{problem}</p>{/if}
      <p class="foot">
        Guests watch through your home connection and never see your addons, keys or watchlist.
        Anything that needs converting for their browser isn’t converted for them. Guests use your
        debrid account, so share it with people you trust. Revoking ends their access, playing
        included.
      </p>

      <h3>Your guests</h3>
      {#if grants?.length}
        <ul class="list">
          {#each grants as grant (grant.gid)}
            <li class="line">
              <span class="label"
                >{grant.name}<small>{standing(grant)}</small><small
                  >{grant.addons
                    .map((addon) => NAMES[addon].label)
                    .join(', ')}{#if grant.devices > 1}
                    · {grant.deviceCount} of {grant.devices} devices{/if}</small
                ></span
              >
              {#if grant.status !== 'revoked'}
                <span class="actions">
                  {#if !(grant.status === 'active' && grant.expiresAt === null)}
                    <button
                      type="button"
                      class="quiet"
                      disabled={working}
                      aria-label="Extend {grant.name} by 7 days"
                      onclick={() => extend(grant, 7)}>+7 days</button
                    >
                    <button
                      type="button"
                      class="quiet"
                      disabled={working}
                      aria-label="Extend {grant.name} by 30 days"
                      onclick={() => extend(grant, 30)}>+30 days</button
                    >
                  {/if}
                  <button
                    type="button"
                    class="quiet"
                    aria-label="Rename {grant.name}"
                    onclick={() => (renaming = { gid: grant.gid, name: grant.name })}>Rename</button
                  >
                  <Confirm
                    label="Revoke"
                    ariaLabel="Revoke {grant.name}"
                    question="Revoke {grant.name}’s access?"
                    detail="They stop being able to browse or play right away, and anything they’re watching ends."
                    onconfirm={() => void revoke(grant)}
                  />
                </span>
              {/if}
              {#if renaming?.gid === grant.gid}
                {@const edit = renaming}
                <form
                  class="form wide"
                  onsubmit={(event) => {
                    event.preventDefault();
                    if (edit.name.trim()) void change(grant, { name: edit.name.trim() });
                  }}
                >
                  <input
                    class="field"
                    maxlength="60"
                    aria-label="New name for {grant.name}"
                    bind:value={edit.name}
                  />
                  <button class="primary" disabled={working || !edit.name.trim()}>Save</button>
                  <button type="button" class="quiet" onclick={() => (renaming = null)}
                    >Cancel</button
                  >
                </form>
              {/if}
            </li>
          {/each}
        </ul>
      {:else if grants}
        <p class="status">No one yet.</p>
      {/if}
    {/if}
  </SettingRow>

  <SettingRow
    id="shared-with-you"
    label="Shared with you"
    detail="Use someone else’s addons"
    value={held.length ? String(held.length) : ''}
  >
    <h3>Enter invite code</h3>
    <form
      class="form"
      onsubmit={(event) => {
        event.preventDefault();
        void accept();
      }}
    >
      <input
        class="field mono"
        autocomplete="off"
        spellcheck="false"
        placeholder="Paste a code or a link"
        aria-label="Invite code or link"
        bind:value={pasted}
      />
      <button class="primary" disabled={redeeming || !pasted.trim()}
        >{redeeming ? 'Checking…' : 'Use invite'}</button
      >
    </form>
    {#if redeemNote}<p class="status" class:bad={redeemNote.bad} role="status">
        {redeemNote.text}
      </p>{/if}
    {#if held.length}
      <h3>Your invites</h3>
      <ul class="list">
        {#each held as grant (grant.gid)}
          <li class="line">
            <span class="label"
              >Shared by {grant.name}<small>{accessLine(grant)}</small><small
                >{Object.keys(grant.addons)
                  .map((addon) => NAMES[addon as GrantAddon].label)
                  .join(', ')}</small
              ></span
            >
            <Confirm
              label="Leave"
              ariaLabel="Leave {grant.name}’s invite"
              question="Leave {grant.name}’s invite?"
              detail="You stop using their addons on this browser. They can invite you again."
              onconfirm={() => void guestGrants.leave(grant.gid)}
            />
          </li>
        {/each}
      </ul>
    {/if}
    <p class="foot">
      Their addons are used alongside yours and can’t be seen or changed here. Some releases can’t
      be played in a browser that lacks their video format, because shared libraries don’t convert
      video. Your own library and watchlist stay in this browser.
    </p>
  </SettingRow>
</SettingsSection>

<style>
  .made {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 12px;
    padding: 14px 16px;
    border-radius: 12px;
    background: rgb(255 255 255 / 0.03);
  }

  .made p {
    margin: 0;
    color: var(--muted);
    font-size: 14px;
  }

  .made p b {
    color: var(--fg);
  }

  .made > button {
    align-self: flex-start;
  }

  .copy {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .wide {
    flex-basis: 100%;
  }

  .labelled {
    display: grid;
    flex: 1 1 200px;
    gap: 4px;
    color: var(--muted);
    font-size: 13px;
  }
</style>
