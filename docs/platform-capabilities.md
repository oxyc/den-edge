# Platform capabilities

Den keeps playback and personal-library behavior consistent across clients, but it does not copy every
administration screen onto every remote or legacy engine. The browser is the primary household-administration
surface. Other clients either provide a smaller, device-appropriate control or a visible handoff to the browser.

This table is a **product-scope contract**, not a hardware-qualification claim. “Supported” means the product is
intended to expose the operation on that target. It does not mean every television model, OS release, media engine,
entitlement, or accessibility path has completed physical-device qualification.

Legend:

- **Supported** — the target owns the operation.
- **Subset** — the target owns the personal or remote-practical part; the notes name the boundary.
- **Web handoff** — the target explains where to finish the operation in an Owner-authorized browser session.
- **Unavailable** — deliberately excluded; the client must not imply that the operation succeeded.

| Capability | iPhone / iPad | Apple TV | Browser | LG / webOS | Modern Samsung / Tizen | Reduced Samsung / Tizen 3 |
|---|---|---|---|---|---|---|
| Browse and play | Supported | Supported | Supported | Supported | Supported | Supported viewer path |
| Personal playback and content preferences | Supported for a ready linked profile; local-only mode has a smaller surface | Supported; Visitor values are visit-local | Supported | Supported | Supported | Subset: playback-facing profile controls only |
| Mobile Visitor profile | **Unavailable**; tracked by [Den #529](https://github.com/oxyc/den/issues/529) | Supported, visit-local | Supported, visit-local | Supported, visit-local | Supported, visit-local | Subset; no household authority |
| Household administration | Web handoff for complex operations | Subset of remote-practical controls; Web handoff for complex or destructive operations | **Primary supported surface** | Subset plus Web handoff | Subset plus Web handoff | **Unavailable**; Web handoff |
| Add Kid | Supported for the active Owner | Supported for the active Owner | Supported | Supported | Supported | **Unavailable**; no Add Kid handoff is currently rendered |
| Broader profile lifecycle: rename, delete, or create an adult profile | **Unavailable**; open product work | **Unavailable**; open product work | **Unavailable**; open product work | **Unavailable**; open product work | **Unavailable**; open product work | **Unavailable** |
| Persistent Kid title approvals | Exact-title Web handoff | Exact-title Web handoff | Supported | Web handoff | Web handoff | **Unavailable**; Web handoff |
| Owner PIN administration | Verify or Web handoff; no duplicate secret editor | Verify or Web handoff | Supported | Supported | Supported | **Unavailable**; Web handoff |
| Metadata, provider, and Apple TV Access credentials | Web handoff; the installed phone token is not rewritten by Web Access changes | Supported Owner administration | Supported Owner administration | Supported Owner administration | Supported Owner administration | **Unavailable**; no credential-management handoff is currently rendered |
| Assistant onboarding and consent | List/revoke plus Web handoff | List/revoke plus Web handoff | Supported | Supported | Supported | **Unavailable**; Web handoff; assistant crypto and queues are compiled out |
| Compound household/profile key reset | Supported native rotation and recovery | Supported native reset and recovery | Supported | Supported | Supported | **Unavailable**; Web handoff; reset crypto is compiled out |
| SIMKL administration | Supported for the legacy or exact active Owner; unavailable to Kid and Visitor | Legacy Owner supported; persistent Owner uses Web handoff | Supported for the exact active Owner | Supported for the exact active Owner | Supported for the exact active Owner | **Unavailable**; Web handoff; tracker controls and delivery are compiled out |
| Trakt administration | **Unavailable** | **Unavailable** | **Unavailable** | **Unavailable** | **Unavailable** | **Unavailable** |
| History import/export | **Unavailable** | **Unavailable** | Supported | Capability-eligible but device chooser/download behavior is unqualified | Capability-eligible but device chooser/download behavior is unqualified | **Unavailable** |

The tracker rows reflect the authority and handoff contract completed by
[Den PR #989](https://github.com/oxyc/den/pull/989) and
[den-edge PR #1286](https://github.com/oxyc/den-edge/pull/1286). They do not claim live-provider or physical-TV
qualification.

The native Add Kid cells reflect the Owner-only production routes in `MobileProfilesView` /
`PairedLibrarySession.createKidProfile` and `ProfilesSetupView` / `AddKidProfileView`. They do not imply rename,
delete, Adult-profile creation, or physical-device qualification. The reduced Tizen 3 package compiles the Add Kid
form out; its guest-administration handoff is not a profile-creation handoff.

## Boundaries that must stay visible

- A missing capability is not an empty result or a successful no-op. Hide the unsupported action or present a
  localized, focusable handoff that names the supported surface.
- Kid and Visitor profiles never receive a household writer. Personal settings remain scoped to the active profile;
  Visitor state is local to that visit where Visitor is supported.
- Tizen 3 is intentionally a reduced viewer build. It must not import or drain assistant work, edit credentials,
  initiate compound reset, or load the heavy crypto/administration chunks used by capable builds.
- Build credentials can narrow a supported integration. Credential-disabled means unavailable, not disconnected or
  failed. A capable Web-family build binds SIMKL to the exact active Owner profile; household, Kid, Visitor, and stale
  replacement models cannot acquire tracker administration.
- Shared source does not establish device qualification. LG, Samsung, Apple TV, iPhone, and iPad still require the
  relevant remote, accessibility, storage, lifecycle, playback-engine, and performance checks.

## Capability work that is not settled yet

The table must not turn an open decision or an unqualified implementation into a supported claim. These original
parity items remain open:

- [Den #528](https://github.com/oxyc/den/issues/528): physical-device performance qualification for mobile
  next-episode prefetch and continuity.
- [Den #529](https://github.com/oxyc/den/issues/529): transactional, ephemeral Mobile Visitor support.
- [Den #532](https://github.com/oxyc/den/issues/532): the remaining detailed Settings scope decisions behind this
  summary matrix.
- [Den #544](https://github.com/oxyc/den/issues/544): the broader profile lifecycle outside the browser-primary
  administration policy.
- [Den #545](https://github.com/oxyc/den/issues/545), [#546](https://github.com/oxyc/den/issues/546), and
  [#550](https://github.com/oxyc/den/issues/550): native controls, signed system integrations, playback routes, and
  cross-host/profile/restart qualification.

## Maintaining the matrix

Any addition, removal, or behavior change must update this document in the same change when it alters a cell. Verify
the production entry point, role/profile authority, unsupported state or handoff, failure and retry behavior, durable
readback, localization/accessibility, and the equivalent paths on every target. Keep implementation and qualification
issues linked rather than changing **Unavailable** to **Supported** from source presence alone.

The detailed Settings authority audit lives in [Den #532](https://github.com/oxyc/den/issues/532). The cross-platform
implementation rules and completion record live in [Den #481](https://github.com/oxyc/den/issues/481).
