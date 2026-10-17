<!-- Settings › Sharing: lending your addons to a guest, and using addons lent to you. A guest gets an invite code from
     the owner; they are not a member of the owner's library and never see its addons, keys or watchlist — den-edge
     holds the owner's installs and the guest's browser only ever holds a secret of its own (`grants.ts`). What a guest
     holds lives in this browser (`grants.svelte.ts`), never in the library. -->
<script lang="ts">
  import { tick, untrack } from 'svelte';
  import ActionMenu from '../components/ActionMenu.svelte';
  import Button from '../components/Button.svelte';
  import DetailIcon from '../components/DetailIcon.svelte';
  import Confirm from './Confirm.svelte';
  import PhoneLink from './PhoneLink.svelte';
  import Select from './Select.svelte';
  import SettingRow from './SettingRow.svelte';
  import SettingsSection from './SettingsSection.svelte';
  import { copyText } from '../lib/clipboard';
  import {
    cappedCodeExpiry,
    createGrant,
    DAY,
    DEFAULT_REDEEM_DAYS,
    GRANT_ADDONS,
    inviteLink,
    keepCode,
    keepUploaded,
    keptCodes,
    listGrants,
    newGrantCode,
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
  import type { MenuItem } from '../lib/titleActions';
  import type { Link } from '../lib/links.svelte';
  import type { LibraryModel } from '../lib/libraryModel.svelte';
  import { hostGrantsFetch } from '../lib/relayFetch';
  import type { Routes } from '../lib/routes';
  import { hostedInstalls } from '../lib/scout';

  let {
    link,
    model,
    plugins,
    routes,
    ready,
    sealHandover,
    selfId,
  }: {
    /** Null for a browser using its own library: it proves no membership, so it has nothing to lend. */
    link: Link | null;
    /** The household control model. Grants belong to it even while a separate Owner profile is active. */
    model: LibraryModel;
    /** The library's own plugins, which a grant's installs come from. */
    plugins: string[];
    routes: Routes;
    /** The library is open, and with it the membership proof the host routes need. */
    ready: boolean;
    /** Seals the library key for a device pairing with this one ("Use Den on your phone"). */
    sealHandover: (
      handoverKey: string,
      host: string,
      linkKey: string,
    ) => Promise<{ sealed: string; linkKey: string; inboxKey: string }>;
    /** This browser's id in the device list. */
    selfId: string;
  } = $props();

  const NAMES: Record<GrantAddon, { label: string; role: string }> = {
    scout: { label: 'Den Scout', role: 'Streams' },
    atlas: { label: 'Den Atlas', role: 'Discovery' },
    reel: { label: 'Den Reel', role: 'Trailers' },
    subtitles: { label: 'Den Subtitles', role: 'Subtitles' },
  };
  const DEVICE_LIMITS = Array.from({ length: 5 }, (_, index) => {
    const devices = index + 1;
    return { value: String(devices), label: `${devices} device${devices === 1 ? '' : 's'}` };
  });
  const day = (at: number) =>
    new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

  // The host's side.
  const installs = $derived(hostedInstalls(plugins, routes));
  let grants = $state<Grant[] | null>(null);
  let problem = $state<string | null>(null);
  let working = $state(false);
  let name = $state('');
  let trial = $state<'none' | '7' | '30' | 'custom'>('none');
  let customDays = $state(14);
  let redeemBy = $state(DEFAULT_REDEEM_DAYS);
  let devices = $state(1);
  /** The invite just made, or a guest's new link: `title` heads the panel, `notes` say what changed. */
  let created = $state<{ name: string; code: string; title: string; notes: string[] } | null>(null);
  let madePanel = $state<HTMLDivElement>();
  let copied = $state<string | null>(null);
  /** Set once a copy fell back all the way to "select it yourself": the field is already selected for it. */
  let manualLink = $state(false);
  let manualCode = $state(false);
  let linkField = $state<HTMLInputElement>();
  let codeField = $state<HTMLInputElement>();
  let renaming = $state<{ gid: string; name: string } | null>(null);
  /** The guest whose revoke is being asked about; the question opens from their menu. */
  let revoking = $state<string | null>(null);
  /** Chosen in a guest's menu, asked about as soon as that menu has closed. */
  let revokeNext: string | null = null;
  let menus = $state<Record<string, ActionMenu | undefined>>({});
  /** A native picker shows its choice immediately. Keep that optimistic value explicit so a refused edit rolls back. */
  let deviceLimits = $state<Record<string, number>>({});
  /** Codes of this browser's unused invites, so their links can be copied again (`keptCodes`). */
  let codes = $state<Record<string, string>>({});

  // A new invite always carries every install that can actually be escrowed. The grant protocol keeps the legacy
  // service names because Edge derives the stable guest Hearth overlay from them; bare or foreign plugins never
  // enter `hostedInstalls`, so "all" cannot accidentally widen beyond this household's shareable sealed configs.
  const shareable = $derived(GRANT_ADDONS.filter((addon) => installs[addon]));
  const clamp = (n: number, low: number, high: number) =>
    Math.min(high, Math.max(low, Math.round(Number.isFinite(n) ? n : low)));

  const failures: Record<string, string> = {
    too_many_grants: 'You already have 10 guests. Revoke one first.',
    bad_request: 'den-edge didn’t accept that. Check the name and the choices.',
    unreachable: 'Couldn’t reach Den. Check that this device is on your network.',
  };
  const said = (reply: Extract<Reply<unknown>, { ok: false }>) =>
    failures[reply.error] ?? 'That didn’t work. Try again in a moment.';

  async function host() {
    try {
      const membership = await model.relayMembership();
      if (membership) return { id: membership.libraryId, fetch: hostGrantsFetch(membership) };
    } catch (error) {
      console.error('Could not read the household sharing membership', error);
    }
    problem = 'Couldn’t open household sharing. Try again.';
    return null;
  }

  async function refresh() {
    const household = await host();
    if (!household) return;
    const listed = await listGrants(household.id, household.fetch);
    if (!listed.ok) {
      problem = said(listed);
      return;
    }
    problem = null;
    grants = listed.value;
    codes = keptCodes(listed.value.filter((g) => g.status === 'invited').map((g) => g.gid));
    // The plugin list may have changed since the escrow was made: what den-edge holds follows it.
    await reuploadInstalls(household.id, listed.value, installs, household.fetch);
  }

  // Listed once the library is open, and again whenever what would be escrowed changes: its content, as a string,
  // since a list re-read from the log is a new array with the same installs every time the library refreshes.
  const installsKey = $derived(JSON.stringify(installs));
  $effect(() => {
    void installsKey;
    if (ready && link) untrack(() => void refresh());
  });

  async function invite() {
    const household = await host();
    if (!household || !name.trim() || !shareable.length) return;
    working = true;
    problem = null;
    const picks = Object.fromEntries(shareable.map((addon) => [addon, installs[addon]]));
    const reply = await createGrant(
      household.id,
      {
        name: name.trim(),
        addons: shareable,
        installs: picks,
        // Left out at the default, so den-edge's own clock sets it; a custom date stays under its 90-day limit even
        // when this browser's clock runs ahead.
        ...(redeemBy === DEFAULT_REDEEM_DAYS
          ? {}
          : { codeExpiresAt: cappedCodeExpiry(Date.now(), clamp(redeemBy, 1, 89) * DAY) }),
        devices: clamp(devices, 1, 5),
        ...(trial === 'none'
          ? {}
          : { accessDays: trial === 'custom' ? clamp(customDays, 1, 365) : Number(trial) }),
      },
      household.fetch,
    );
    working = false;
    if (!reply.ok) {
      problem = said(reply);
      return;
    }
    await keepUploaded(reply.value.grant.gid, installs, shareable);
    keepCode(reply.value.grant.gid, reply.value.code);
    codes = { ...codes, [reply.value.grant.gid]: reply.value.code };
    created = {
      name: reply.value.grant.name,
      code: reply.value.code,
      title: `${reply.value.grant.name}’s invite.`,
      notes: ['It is shown once.'],
    };
    copied = null;
    manualLink = false;
    manualCode = false;
    name = '';
    grants = [...(grants ?? []), reply.value.grant];
  }

  /** A guest's own re-copy of an already-made invite: no field is shown there to fall back to. */
  async function copy(text: string) {
    copied = (await copyText(text)) === 'copied' ? text : null;
  }

  async function copyLink(address: string) {
    const result = await copyText(address, () => linkField?.select());
    copied = result === 'copied' ? address : null;
    manualLink = result === 'manual';
  }

  async function copyCode(code: string) {
    const result = await copyText(code, () => codeField?.select());
    copied = result === 'copied' ? code : null;
    manualCode = result === 'manual';
  }

  async function change(grant: Grant, patch: GrantChange): Promise<boolean> {
    const household = await host();
    if (!household) return false;
    working = true;
    problem = null;
    const reply = await updateGrant(household.id, grant.gid, patch, household.fetch);
    working = false;
    if (!reply.ok) {
      problem = said(reply);
      return false;
    }
    grants = (grants ?? []).map((g) => (g.gid === grant.gid ? reply.value : g));
    renaming = null;
    return true;
  }

  /** A new link for a guest who already exists (their phone, say): the previous one stops working. */
  async function newLink(grant: Grant) {
    const household = await host();
    if (!household) return;
    working = true;
    problem = null;
    const reply = await newGrantCode(household.id, grant.gid, household.fetch);
    working = false;
    if (!reply.ok) {
      problem =
        reply.error === 'devices_full'
          ? `${grant.name} already has all 5 devices, the most a guest can have, so a new link would have nowhere to go.`
          : reply.error === 'access_ended'
            ? `${grant.name}’s access has ended. Extend it first, then make a new link.`
            : said(reply);
      return;
    }
    const { code, grant: next, devicesRaised } = reply.value;
    keepCode(next.gid, code);
    codes = { ...codes, [next.gid]: code };
    grants = (grants ?? []).map((g) => (g.gid === next.gid ? next : g));
    created = {
      name: next.name,
      code,
      title: `${next.name}’s new link.`,
      notes: [
        'The previous link no longer works.',
        ...(devicesRaised
          ? [
              `Every device slot was in use, so the device limit went up by one, to ${next.devices}.`,
            ]
          : []),
      ],
    };
    copied = null;
    manualLink = false;
    manualCode = false;
    await tick();
    madePanel?.scrollIntoView({ block: 'nearest' });
  }

  const deviceLimit = (grant: Grant) => deviceLimits[grant.gid] ?? grant.devices;

  async function changeDeviceLimit(grant: Grant, devices: number): Promise<void> {
    if (devices === grant.devices || devices < 1 || devices > 5) return;
    deviceLimits = { ...deviceLimits, [grant.gid]: devices };
    await change(grant, { devices });
    const next = { ...deviceLimits };
    delete next[grant.gid];
    deviceLimits = next;
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
    const household = await host();
    if (!household) return;
    const reply = await revokeGrant(household.id, grant.gid, household.fetch);
    if (!reply.ok) {
      problem = said(reply);
      return;
    }
    grants = (grants ?? []).map((g) => (g.gid === grant.gid ? { ...g, status: 'revoked' } : g));
  }

  /** Built when a guest's menu opens, so it always reflects the grant as it stands. */
  function guestItems(grant: Grant): MenuItem[] {
    const items: MenuItem[] = [];
    const code = grant.status === 'invited' ? codes[grant.gid] : undefined;
    if (code) {
      const address = inviteLink(location.origin, code);
      items.push({
        kind: 'item',
        label: copied === address ? 'Copied' : 'Copy invite link',
        onselect: () => void copy(address),
      });
    }
    items.push({
      kind: 'item',
      label: 'New link',
      disabled: working,
      onselect: () => void newLink(grant),
    });
    if (!(grant.status === 'active' && grant.expiresAt === null)) {
      for (const days of [7, 30])
        items.push({
          kind: 'item',
          label: `Extend by ${days} days`,
          disabled: working,
          onselect: () => extend(grant, days),
        });
    }
    for (const { value, label } of DEVICE_LIMITS)
      items.push({
        kind: 'radio',
        group: 'devices',
        label: `Allow ${label}`,
        checked: Number(value) === deviceLimit(grant),
        disabled: working,
        onselect: () => void changeDeviceLimit(grant, Number(value)),
      });
    items.push({
      kind: 'item',
      label: 'Rename',
      onselect: () => (renaming = { gid: grant.gid, name: grant.name }),
    });
    // The question opens once the menu has closed (`onclose`), so the menu's focus return can't land after it.
    items.push({ kind: 'item', label: 'Revoke access…', onselect: () => (revokeNext = grant.gid) });
    return items;
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

  /** "12 plays · 9 h this month · 48 plays total": never a title, only counts. Null before a guest ever played. */
  const usage = (grant: Grant): string | null =>
    grant.playsTotal
      ? `${grant.playsThisMonth} plays · ${grant.hoursThisMonth} h this month · ${grant.playsTotal} plays total`
      : null;

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
    redeemNote = { text: 'Your shared addons are ready.', bad: false };
  }

  const held = $derived(guestGrants.list);
  const accessLine = (grant: (typeof held)[number]) =>
    grant.ended
      ? 'Your shared access ended'
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
        <div class="made" role="status" bind:this={madePanel}>
          <p>
            <b>{created.title}</b> Send them this link, or the code to paste under Settings ›
            Sharing.
            {created.notes.join(' ')}
          </p>
          <span class="copy">
            <input
              class="field mono"
              readonly
              aria-label="Invite link"
              value={address}
              bind:this={linkField}
            />
            <Button
              variant="secondary"
              label={copied === address ? 'Copied' : 'Copy link'}
              onclick={() => void copyLink(address)}
            />
          </span>
          {#if manualLink}<p class="status" role="status">Select and copy the link.</p>{/if}
          <span class="copy">
            <input
              class="field mono"
              readonly
              aria-label="Invite code"
              value={code}
              bind:this={codeField}
            />
            <Button
              variant="secondary"
              label={copied === code ? 'Copied' : 'Copy code'}
              onclick={() => void copyCode(code)}
            />
          </span>
          {#if manualCode}<p class="status" role="status">Select and copy the code.</p>{/if}
          <Button variant="secondary" label="Done" onclick={() => (created = null)} />
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
        <Button
          type="submit"
          variant="primary"
          label="Create invite"
          disabled={!ready || working || !name.trim() || !shareable.length}
        />
      </form>
      {#if !shareable.length}
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
            <li class="line guest-line">
              <span class="label"
                >{grant.name}<small>{standing(grant)}</small><small
                  >{grant.addons.map((addon) => NAMES[addon].label).join(', ')}
                  · {grant.deviceCount} of {deviceLimit(grant)}
                  {deviceLimit(grant) === 1 ? 'device' : 'devices'}</small
                >{#if usage(grant)}<small>{usage(grant)}</small>{/if}</span
              >
              {#if grant.status !== 'revoked'}
                <!-- Every control for a guest sits behind one ⋯ at every width, so the row stays the name and
                     where they stand. Revoke is still asked about, in place, below the row. -->
                <div class="guest-menu">
                  <ActionMenu
                    bind:this={menus[grant.gid]}
                    items={() => guestItems(grant)}
                    label="More actions for {grant.name}"
                    heading={grant.name}
                    triggerClass="guest-trigger"
                    onclose={() => {
                      if (revokeNext === grant.gid) revoking = grant.gid;
                      revokeNext = null;
                    }}
                    glyph={more}
                  />
                </div>
                <Confirm
                  hideTrigger
                  bind:asking={
                    () => revoking === grant.gid, (asked) => (revoking = asked ? grant.gid : null)
                  }
                  question="Revoke {grant.name}’s access?"
                  label="Revoke"
                  detail="They stop being able to browse or play right away, and anything they’re watching ends."
                  onclose={() => menus[grant.gid]?.focus()}
                  onconfirm={() => void revoke(grant)}
                />
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
                  <Button
                    type="submit"
                    variant="primary"
                    label="Save"
                    disabled={working || !edit.name.trim()}
                  />
                  <Button variant="secondary" label="Cancel" onclick={() => (renaming = null)} />
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
      <Button
        type="submit"
        variant="primary"
        label={redeeming ? 'Checking…' : 'Use invite'}
        disabled={redeeming || !pasted.trim()}
      />
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
              >Shared addons<small>{accessLine(grant)}</small><small
                >{Object.keys(grant.addons)
                  .map((addon) => NAMES[addon as GrantAddon].label)
                  .join(', ')}</small
              ></span
            >
            <Confirm
              label="Leave"
              ariaLabel="Leave this shared access"
              question="Leave this shared access?"
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
      video. Your own library and watchlist are yours alone: they sync to your other devices, never
      to whoever lent you these.
    </p>
  </SettingRow>
  <PhoneLink {sealHandover} {selfId} />
</SettingsSection>

{#snippet more()}
  <DetailIcon name="more" />
{/snippet}

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

  .made > :global(.den-button) {
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

  /* The name and status take the row; the ⋯ stays beside them even at 320px. */
  .guest-line .label {
    flex-basis: 0;
  }

  .guest-menu {
    position: relative;
  }

  /* The trigger renders inside `ActionMenu`, a child component, hence :global (as `EpisodeCard`'s does). */
  .guest-menu :global(.guest-trigger) {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    color: var(--muted);
  }

  .guest-menu :global(.guest-trigger:hover),
  .guest-menu :global(.guest-trigger[aria-expanded='true']) {
    background: #fff2;
    color: var(--fg);
  }

  .guest-menu :global(.guest-trigger:focus-visible) {
    outline: 2px solid var(--accent);
  }
</style>
