/**
 * The web console's **platform-module contract**
 * (integration-plugin-architecture.md §10, stage S3) — published FIRST, with
 * every implementation still in place. Same sequencing as the daemon's Layer-1
 * contract (#525), the relay's two-sided ingress contract (#560), and the CP's
 * provider contract (#565): moving a body while ALSO changing what it can reach
 * is how a file move becomes a silent contract redesign (§16), so the seam
 * lands as types, and the four platforms' wizard panes / settings fragments /
 * marks move against it in their own PRs.
 *
 * WHERE THIS LIVES. §10 keeps modules IN the web tree
 * (`src/components/console/platforms/<id>/`) per D1 — no cross-package React,
 * no Tailwind `@source` bookkeeping — so the contract sits at that directory's
 * root. A types-only file needs no `use client` (type imports are erased at
 * build); the concrete modules inherit the app convention that ModalProvider /
 * the view shells are the client boundary (AddIntegrationModal.tsx:1).
 *
 * THE INSTANCE MODEL. A module is per-platform, stateless, registered once —
 * a bag of React components, pure predicates, copy, and its own typed CP
 * client bindings. Unlike the daemon/relay/CP slots there is no lifecycle:
 * nothing is constructed or started. All wizard/settings STATE lives inside
 * the module's components (today's `useState` blocks move with the JSX that
 * reads them); the few axes the HOST must own — because host-rendered chrome
 * reads them too — are enumerated on {@link WizardHost}.
 *
 * WHAT STAYS HOST-OWNED (§10's chassis list, verified against the monolith):
 *  - the platform picker tiles and their daemon-capability gate
 *    (`daemon.caps.platforms`, AddIntegrationModal.tsx:1205-1216, tiles
 *    :2199-2236; the gate is duplicated verbatim at AgentDetailView.tsx:418-423
 *    with its own tile grid :1534-1568 — the registry replaces both hardcoded
 *    lists, the gate itself stays host);
 *  - the webhook/github exemption from that gate (:1212-1215) — those picks
 *    mint relay/CP-backed triggers, not bot identities, and their whole wizard
 *    sections (:2238-2372, :2373-2821) are core fragments, explicitly NOT
 *    modules of this contract;
 *  - the existing/create mode cards (:2887-2934; the module supplies only
 *    their per-platform copy, {@link WebWizardFacet.identityCards});
 *  - the generic free-bot reuse list (:2935-2988; the module supplies only
 *    the eligibility predicate, {@link WebWizardFacet.freeBotFilter});
 *  - the Bot-identity header and the visibility of that whole identity
 *    chassis (:2867-2883) — a module whose pane REPLACES it (Slack's
 *    built-in/custom fork) publishes visibility and the header's
 *    return-to-built-in action through
 *    {@link WizardHost.setIdentityChrome}, never by reaching into host
 *    chrome;
 *  - the footer bar and its Cancel action (:3758-3771; the module drives the
 *    primary through {@link WizardHost.setFooter});
 *  - the shared-bot toggle widget (:3736-3750) and the error banner
 *    (:3751-3756);
 *  - the platform-switch reset seam: today 20 lines of manual `set*('')`
 *    (:1220-1241, repeated in the caps effect :1246-1265). Under the contract
 *    the host remounts {@link WebWizardFacet.Body} keyed by platformId, so a
 *    module's state resets by construction and the reset list stops being a
 *    cross-platform maintenance point.
 *
 * ONE RESPONSIVE TREE. The wizard renders base mobile classes + `desktop:`
 * variants (:2199, :2888) per the repo's mobile conventions; the contract
 * deliberately has NO mobile axis — no `isMobile` host member, no split
 * component slots — so a module CANNOT fork the wizard into desktop/mobile
 * trees. A fragment whose interaction genuinely diverges calls `useIsMobile()`
 * itself, exactly like today's walkthrough disclosure
 * (AddIntegrationModal.tsx:551-556).
 *
 * DELIBERATELY ABSENT — §5 manifest values. `displayName`, `regions` (ids,
 * labels, portal hosts), `ingress`, `leaveGranularity`,
 * `membershipEnumeration`, `multiAgentShareable` are cross-host manifest
 * fields per D2, not members here — the same exclusion the CP contract makes.
 * The daemon's S2 manifest (`packages/daemon/src/platforms/manifest.ts`) is
 * deliberately daemon-local; the shared §5 manifest lands in protocol with the
 * web registry, and until then the host literals keep carrying those values
 * (`BOT_PLATFORMS` labels :94-105, `LarkFeishuSwitcher`, `platName`'s chat
 * arms data.ts:1923-1939, the region badge AgentDetailView.tsx:113-121).
 * Where §10's sketch ALREADY mirrors a manifest axis onto the module —
 * `affordances.transport`/`affordances.share` — the mirror is kept, because
 * the wizard needs per-platform COPY and a default rule the pure manifest
 * value cannot carry; the doc on each member names its §5 twin.
 *
 * ALSO DELIBERATELY ABSENT: the sign-in provider catalog
 * (`lib/social-login-providers.ts`, `SocialLoginMark` marks.tsx:280-289) —
 * ids that coincide with chat-platform ids but belong to the OIDC connector
 * axis (audit Appendix D, ambiguous row 8); the core-kind marks (webhook /
 * schedule / dream / playground arms of `PlatformMark`, marks.tsx:217-252);
 * cron/hook targeting (§6.8, core; `CronDto.targetPlatform` is already an
 * open string, api.ts:591); and the playground/webchat/hook session special
 * cases (audit class d).
 *
 * MOCK AND ASSET CARRIERS (audit Appendix D §4). {@link WizardHost.mockMode}
 * exposes the one cross-cutting flag; the per-platform mock FIXTURES
 * (data.ts:1140-1622, data-context.tsx:277-490) and the per-platform CSS
 * tokens/animations + `public/brands/lark.svg` are carriers that move WITH
 * their modules in the move PRs — Tailwind v4 source scanning over the module
 * directories is exactly why D1 keeps modules in this tree (see
 * packages/web/STYLE.md).
 */
import type { ComponentType, ReactNode } from 'react'
import type { BotDto, CreateIntegrationInput, SessionMessageDto } from '@/lib/api'
import type { Agent, IntegrationRow } from '@/lib/data'

/** Inbound transport chosen in the wizard — same value set the create DTOs
 *  carry (api.ts:654-672) and the CP persists. */
export type WebWizardTransport = 'socket' | 'http'

/**
 * The footer primary as one platform's create flow wants it RIGHT NOW —
 * published by the wizard Body through {@link WizardHost.setFooter}. The three
 * audited shapes it must reproduce (AddIntegrationModal.tsx:2142-2179): the
 * Slack auto flow's final "Connect" (enabled once the install is bot-ready and,
 * on socket, an app-level token is pasted), the config-setup "Connect &
 * authorize" (enabled once a config token is typed), and the manual "Connect &
 * authorize" over the platform's own validity predicate (:1389-1397). A busy
 * flow republishes with `enabled: false` and a progress label — today's
 * `'Creating…'/'Connecting…'` swap (:3768) — instead of a separate flag.
 */
export interface WizardFooterState {
  label: string
  enabled: boolean
  onSubmit(): void
  /** Suppress the primary entirely — panes whose commit is an inline button of
   *  their own: the Slack built-in "Add to Slack" pane and the Feishu deeplink
   *  flow (`!hideIdentitySection && !isFeishuDeeplink`, :3765-3770). */
  hidden?: boolean
}

/**
 * Identity-chassis publication — how a module-owned pane state drives the
 * HOST-owned identity chrome it must hide or extend. The audited case is
 * Slack's built-in/custom fork: `hideIdentitySection` derives from
 * module-owned funnel state (`slackChecking || slackBuiltin`,
 * AddIntegrationModal.tsx:1298-1301) yet gates the host's Bot-identity header
 * (:2867), mode cards (:2887), free-bot list (:2935), and share toggle
 * (:3736), while the host-owned header renders "Use the built-in Slack app"
 * — an action that mutates the module's own `slackIdentity` state
 * (:2872-2881). Published through {@link WizardHost.setIdentityChrome},
 * exactly like the footer channel, so the module never reaches around the
 * boundary and the host never grows a platform branch.
 */
export interface WizardIdentityChromeState {
  /** Hide the whole identity chassis — header, mode cards, free-bot list, and
   *  the share toggle (today's `hideIdentitySection` consumers, :2867, :2887,
   *  :2935, :3736) — while the Body renders its own replacement pane (the
   *  Slack built-in "Add to Slack" pane :2825-2866) or its probe spinner
   *  (`slackChecking`, :1299-1301). The footer rides its own channel
   *  ({@link WizardFooterState.hidden}). */
  hidden: boolean
  /** Optional action the host renders in the identity header, calling back
   *  into the module — today's "Use the built-in Slack app" return
   *  affordance (:2872-2881), shown only while the custom flow is open and
   *  the built-in pane is offered (`builtinAppOffered`, :1298). Presentation
   *  (icon, placement) is the host's. */
  headerAction?: { label: string; onSelect(): void }
}

/** Wizard state the reuse predicates read — one context type for both
 *  {@link WebWizardFacet.freeBotFilter} and
 *  {@link WebWizardFacet.buildReuseInput}. */
export interface WizardReuseContext {
  /** The owning agent (the modal is opened FROM an agent, never picks one —
   *  AddIntegrationModal.tsx:975-988). */
  agentId: string
  /** Active region id (§5 `regions` vocabulary; `'lark' | 'feishu'` today) on
   *  a platform with regional clouds; undefined elsewhere. */
  region?: string
  /** The shared-bot opt-in, as {@link WizardHost.shared}. */
  shared: boolean
}

/**
 * Host services the wizard Body receives — the modal chassis's side of the
 * contract. This is the state HOST-RENDERED chrome also reads (mode cards,
 * free-bot list, share toggle, footer, error banner), which is exactly why it
 * cannot live inside the Body: both sides render from it.
 *
 * Refinements against §10's sketch, from the audit:
 *  - `freeBots` is NOT a member — the host filters and renders the reuse list
 *    itself (:1278-1285, :2935-2988); a Body only ever needs the SELECTED bot
 *    (the Feishu checklist keys its delivery rows on the reused bot's
 *    transport, :1326 + :3700-3709; the share gate reads it too, :1321-1323).
 *  - `daemonCaps` is NOT a member — the capability gate guards the host's
 *    picker tiles (:1205-1216) and nothing inside any platform pane reads it.
 *  - `isMobile` is NOT a member — see ONE RESPONSIVE TREE in the module doc.
 */
export interface WizardHost {
  /** Commit one create/reuse input and refresh the console's integration
   *  projections (`useConsoleData().createIntegration`,
   *  lib/data-context.tsx:192). The host commits the REUSE path itself via
   *  {@link WebWizardFacet.buildReuseInput}; a Body calls this from its own
   *  footer `onSubmit` with its create-shaped input (today's per-platform
   *  arms of `submit()`, AddIntegrationModal.tsx:1759-1799). */
  createIntegration(input: CreateIntegrationInput): Promise<void>
  /** Deployment-level public-callback capability — whether a relay is
   *  connected and its public base URL. Today every platform learns it from
   *  the Slack-named config probe (`fetchSlackConfig().relayAvailable /
   *  relayPublicUrl`, api.ts:741-742 — the Feishu pane calls the same
   *  endpoint, :2044-2061, and derives its callback URL from it, :1386).
   *  Under the contract the host owns the probe; the SLACK-funnel flags
   *  riding the same DTO (`funnelEnabled`, `autoAvailable`,
   *  `platformInstallAvailable`) are module state, fetched by the Slack
   *  module's own bindings. */
  relayCapability: { available: boolean; publicUrl: string | null }
  /** Bot-identity mode, owned by the host's mode cards (:1192, :1286). */
  mode: 'create' | 'existing'
  /** The reuse candidate selected in the host's free-bot list (:1302-1303);
   *  null in create mode / when the platform has no free bots. */
  selectedBot: BotDto | null
  /** Active region id — host state because the PICKER TILE hosts the region
   *  switcher (:2222-2230) and callers preselect it (`initialFeishuRegion`,
   *  :982). Undefined on regionless platforms. */
  region?: string
  /** Freeze the host's region switcher while this module holds a STARTED,
   *  region-bound flow. A Feishu device registration is minted against ONE
   *  cloud, so relabelling it mid-poll would present the pending
   *  authorization URL as the other cloud's — the monolith disabled the tile's
   *  switcher on `feishuPhase === 'authorizing'` for exactly that reason
   *  (:2226). Published like the footer and identity channels; a module that
   *  never calls it leaves the switcher free, and the host clears the lock
   *  whenever the picked platform changes. */
  setRegionLocked(locked: boolean): void
  /** The effective inbound transport (:1310-1311). Only meaningful when the
   *  module declares {@link WebWizardAffordances.transport}. */
  transport: WebWizardTransport
  /** Pick the transport. The host applies the one cross-cutting rule itself:
   *  switching to socket drops the shared opt-in, because shared bots are
   *  relay-backed and therefore http-only (:1314-1317); switching TO http is
   *  only offered while `relayCapability.available` (:352). A funnel that
   *  pins the transport to a created app's row (`install.transport`,
   *  :1307-1311) calls this once and stops offering its own switch. */
  setTransport(next: WebWizardTransport): void
  /** The effective shared-bot opt-in the host toggle maintains (`wantShared`,
   *  :1321-1326) — Bodies thread it into their create/finalize calls
   *  (:1768, :1999). */
  shared: boolean
  /** Design/dev mode with no CP behind the console (`MOCK_MODE`) — real
   *  branches inside platform flows read it today (the Telegram probe skips
   *  itself, :1342-1353; the Slack funnel pretends everything is configured,
   *  :2016-2024), so the flag is host-provided. Per-module mock FIXTURES are
   *  the module's own (see the module doc). */
  mockMode: boolean
  /** Publish or clear this platform's create-path footer primary. The host
   *  renders the reuse footer itself (label and `selectedBot !== null`
   *  enablement are platform-free, :1397, :2179). */
  setFooter(state: WizardFooterState | null): void
  /** Publish or clear this platform's identity-chassis state — visibility of
   *  the host-owned header/mode-cards/free-bot-list/share-toggle chrome plus
   *  the header's module callback action. `null` (and every platform that
   *  never calls this) ⇒ the default chassis: visible, no header action —
   *  today's non-Slack behavior. See {@link WizardIdentityChromeState}. */
  setIdentityChrome(state: WizardIdentityChromeState | null): void
  /** Show `message` in the host's error banner (:3751-3756); null clears. The
   *  terminal states of module-owned polls land here (the Feishu registration
   *  poll's failure copy, :1953-1974). */
  setError(message: string | null): void
  /** Close the modal — flows that complete out-of-band close it themselves
   *  (the Feishu poll on `completed`, :1964; the platform-install poll,
   *  :2094). */
  close(): void
  /** Refetch the console's integration/bot projections
   *  (`useConsoleData().refresh`, lib/data-context.tsx:233) — for completions
   *  that did NOT ride {@link createIntegration} (the Feishu poll refreshes
   *  before closing, :1963). */
  invalidate(): void
}

/** One platform's transport affordance — declared only by platforms offering
 *  a socket/http choice (Slack, Feishu today; `TRANSPORT_LABEL`'s key set,
 *  AddIntegrationModal.tsx:328-331). The §5 manifest's `ingress` axis says
 *  which transports EXIST; this member carries what the wizard additionally
 *  needs — display copy and the default rule — which pure manifest data
 *  cannot. */
export interface WebTransportAffordance {
  /** Platform vocabulary for the delivery-mode line (:328-331 —
   *  Slack "Socket Mode"/"HTTP (Events API)", Feishu "Long connection"/"HTTP
   *  callbacks"), rendered by the Body's own delivery line (:337-371). */
  labels: Record<WebWizardTransport, string>
  /** Default transport rule (:1310-1311): true ⇒ default to `http` whenever
   *  the deployment has relay delivery (Slack); false ⇒ always start on
   *  `socket` and offer http as an explicit choice (Feishu). */
  httpByDefaultWhenRelayAvailable: boolean
}

/** Which host-rendered wizard affordances this platform gets (§10). */
export interface WebWizardAffordances {
  /** Absent ⇒ single fixed transport; the host neither shows a delivery
   *  choice nor lets {@link WizardHost.transport} vary (Telegram/Discord,
   *  whose create DTOs carry no transport at all, api.ts:660-661). */
  transport?: WebTransportAffordance
  /**
   * The platform supports multi-agent bots — the console's mirror of the §5
   * manifest's `multiAgentShareable`, which is what the CP's two gates read.
   *
   * THREE VALUES, because "supported" and "chosen by the operator" are different
   * facts and collapsing them shipped a control for a decision that does not exist:
   *  - absent ⇒ the platform has no multi-agent bot at all (Telegram, Discord,
   *    Feishu). Neither surface offers sharing.
   *  - `true` ⇒ multi-agent is an OPT-IN the operator makes (Slack). The host
   *    still applies the http-only gate itself — create mode on the chosen
   *    transport, reuse mode on the reused bot's own (:1321-1326).
   *  - `'fixed'` ⇒ multi-agent is STRUCTURAL: the provider stamps `shareable`
   *    itself and the flag is not a caller's to move (Linear — a Bot row IS one
   *    connected workspace, and a workspace is definitionally multi-agent,
   *    linear-integration.md §4.3). Reuse still admits members, but neither the
   *    wizard opt-in nor the Settings toggle renders, because flipping it OFF is
   *    a state the provider contract does not have and whose only recovery would
   *    be re-running the OAuth funnel.
   *
   * Nested under `wizard` for where it is DECLARED, not for where it may be
   * read: it is a platform fact, and the Settings → Bots Sharable cell reads the
   * same one through `platformSupportsSharing` / `platformSharingFixed`
   * (registry.ts). That toggle shipped gated on transport ALONE, which left a
   * Feishu HTTP bot — a non-shareable platform whose bots can be
   * `transport: 'http'` — offering a live control for a capability the CP
   * refuses. The fix is this member, not a second one on
   * {@link WebBotSettingsFragments}: a Settings-side mirror could disagree with
   * the wizard's about the same platform, and one declaration cannot.
   */
  share?: boolean | 'fixed'
}

/**
 * The install wizard facet — what `AddIntegrationModal` needs from a platform
 * to render its pane as a fragment (S3 exit criterion: the modal is chassis +
 * fragments).
 */
export interface WebWizardFacet {
  /**
   * The platform's whole create-mode pane: portal walkthroughs, credential
   * fields and their format validators (:1331-1397), live probes (the
   * debounced Telegram getMe/privacy check :1340-1374, the Slack funnel
   * machine :1049-1091 + :2014-2039, the Feishu deeplink flow :1913-1982),
   * install polling, and per-step inline actions. Rendered by the host
   * between the mode cards and the shared footer chrome; remounted on
   * platform switch (the reset seam — see the module doc). The Body drives
   * the host footer via {@link WizardHost.setFooter}, the identity chassis
   * via {@link WizardHost.setIdentityChrome} (the Slack built-in/custom
   * fork), and commits through its own api bindings +
   * {@link WizardHost.createIntegration}.
   */
  Body: ComponentType<{ agent: Agent; host: WizardHost }>
  /**
   * Per-platform reuse eligibility BEYOND the host's generic predicate. The
   * host already keeps only this platform's live, uninstalled bots
   * (`b.platform === platform && !b.inUseByAgentId && !b.revokedAt`,
   * :1278-1285); the module adds what only it knows — Slack refuses a
   * platform-app workspace install that has not been flipped shareable
   * (`!b.teamId || b.shareable`, :1284 — the server rejects it, so the list
   * must not offer it); Feishu matches the active region
   * (`(b.feishuRegion ?? 'feishu') === region`, :1281).
   */
  freeBotFilter(bot: BotDto, ctx: WizardReuseContext): boolean
  /**
   * Build the reuse-mode create input for one selected free bot — today's
   * per-platform arms of `submit()`'s `mode === 'existing'` branch
   * (:1739-1758): Slack/Feishu carry the reused bot's own transport
   * (`selectedBot.transport ?? 'socket'`); Slack attaches `shareable` from
   * `ctx.shared`; Telegram/Discord are `platform + agentId + botId`. The
   * HOST calls this and commits — reuse needs no Body participation.
   */
  buildReuseInput(bot: BotDto, ctx: WizardReuseContext): CreateIntegrationInput
  affordances: WebWizardAffordances
  /**
   * Copy for the host's existing/create mode cards — today's
   * `botIdentityCopy` record (:1027-1032). A function of the active region
   * because regional brands rewrite it ("Create with one-click Lark setup"
   * vs "…Feishu setup").
   */
  identityCards(region: string | undefined): { create: string; existing: string }
  /**
   * The one-line "invite the bot" hint under the pane — the chat arms of the
   * host's footer hint row (`IM_INVITE_HINT` :154-166, rendered :3722-3735;
   * the webhook/github arms of that row are core copy and stay host-owned).
   * Region-parameterized for the same reason as {@link identityCards}
   * (:3732).
   */
  inviteHint(region: string | undefined): string
}

/**
 * Copy the Settings → Bots card writes into chrome the HOST owns — the words on
 * a bot row that describe a PROVIDER's model rather than AgentConnect's.
 * Deliberately NOT {@link WebBotSettingsFragments.botCard} components: the host
 * renders the `revoked` badge, the Sharable cell and the card's own headings,
 * and owns the conditions under which each appears, so what a module supplies
 * here is the wording, not the element.
 *
 * Every member is optional and every host default is provider-free, because
 * these strings shipped as Slack's model rendered for EVERY platform: the badge
 * tooltip named a "Slack workspace" over a Telegram bot, and the toggle told a
 * Discord bot to switch to a transport Discord does not have.
 */
export interface WebBotCardCopy {
  /**
   * Tooltip on the `revoked` badge (SettingsView.tsx:1085-1092), rendered
   * whenever `BotDto.revokedAt` is set.
   *
   * Absent ⇒ the host's provider-free sentence, which is the honest answer for
   * every platform but Slack rather than a placeholder: `revokedAt` is written
   * by exactly one path, `rc/bot-revoked`, whose reason enum IS Slack's app
   * lifecycle (`app_uninstalled` / `tokens_revoked`,
   * protocol/src/frames/relay-cp.ts). No other platform can reach the state
   * today, so no other module should invent prose about how it got there.
   */
  revokedHint?: string
  /**
   * Tooltip on the Sharable toggle (:1095-1109), per arm — the HOST picks
   * which arm by its own predicate (`(bot.transport ?? 'socket') === 'socket'`),
   * exactly as {@link WebWizardFacet.identityCards} hands over both mode-card
   * sentences and lets the host choose.
   *
   * Absent ⇒ ONE host sentence used for BOTH arms, and the collapse is the
   * point rather than an economy: the server admits multi-agent bots only where
   * the §5 manifest declares `multiAgentShareable`, so on a platform outside
   * that set the transport arm the host lands on is not the reason sharing is
   * unavailable — and two sentences would promise that switching transport helps.
   */
  shareHint?: { available: string; unavailable: string }
  /**
   * What this platform calls the identity a bot row IS: Slack installs an
   * "app", every other platform registers a "bot". The host writes it into its
   * own card chrome — the first column's heading, the delete button's tooltip
   * and the empty-state sentence (SettingsView) — which is why it is copy here
   * and not a fragment.
   *
   * Lower-case singular: the heading uppercases through `.row.h`, and the
   * sentences read "Delete app" / "No apps yet". Absent ⇒ `'bot'`, the noun
   * four of the console's five bot tabs already used.
   */
  identityNoun?: string
}

/**
 * Settings → Bots fragments (§10 `settingsFragments`), split along the real
 * division in `SettingsView.tsx`: pure per-bot adornments, the stateful
 * maintenance machinery, and the copy the host renders into its own chrome.
 *
 * THE CARD STATE IS THE MODULE'S, NOT A HOST PROP. This interface was published
 * with a `TCardState` type parameter — `useCardState()` returning it and the
 * fragments taking it as a prop, "flowing opaquely through the host" the way the
 * relay contract's `TVerified` does. The adoption PR found that shape cannot be
 * built in TypeScript: `WebPlatformRegistry` stores modules as a homogeneous
 * `WebPlatformModule[]`, which resolves `TCardState` to its default, and a
 * `ComponentType<{ card: SlackBotCardState }>` is NOT assignable to
 * `ComponentType<{ card: void }>` — component props are checked
 * contravariantly under `strictFunctionTypes`, so the erasure a registry
 * performs is exactly the one the parameter cannot survive. (The relay's
 * generic works because each route binds `TVerified` at its own call site; a
 * React registry array binds nothing.) Only `any` rescues the prop version.
 *
 * So the state stays INSIDE the module, behind its own context: the host mounts
 * {@link lifecycleActions}' `CardProvider` once per platform tab and the
 * module's own fragments read from it. The host still never learns the shape —
 * it just no longer carries it — and the erasure hazard is gone rather than
 * suppressed with `any`. Mounting per tab (keyed by platform id) is what keeps a
 * module's hooks from changing identity under a live component, the same reset
 * seam the wizard Body uses.
 */
export interface WebBotSettingsFragments {
  /** Pure per-bot row adornments, renderable from the `BotDto` alone. */
  botCard?: {
    /** Name-cell badges — the Slack transport tag that explains the Sharable
     *  toggle's disabled state (SettingsView.tsx:1245-1249). */
    RowBadges?: ComponentType<{ bot: BotDto }>
    /** Action-cell provider deep links: Slack's api.slack.com app settings
     *  (:1312-1324), Discord's ready-made invite (:1325-1337), the Feishu /
     *  Lark console per region (:71-74, :1338-1345). */
    RowLinks?: ComponentType<{ bot: BotDto }>
    /**
     * The delete dialog's "what AgentConnect cannot delete for you" block —
     * the provider sentence plus its deep link (DeleteBotModal.tsx:51-71).
     * A member of its own rather than a reuse of {@link RowLinks}: the row
     * link is a bare icon button in a 100px action track, this is a labelled
     * secondary button under an explanatory sentence. Absent ⇒ the dialog
     * shows no provider block, which is the right answer for a platform whose
     * bot has no console page to finish the job on (Telegram: BotFather is a
     * chat, not a URL).
     */
    DeleteNotice?: ComponentType<{ bot: BotDto }>
  }
  /** Stateful bot-maintenance flows — today Slack's manifest-refresh and
   *  builtin-reinstall machinery, ~180 lines of card-scoped state
   *  (:1036-1134) feeding both a row control and a card banner. */
  lifecycleActions?: {
    /** Mounts the card-scope state, once per platform tab, around the host's
     *  row list. Owns the cross-row invariants the audit found — one refresh
     *  in flight per card (`slackRefreshBusyId`), one reinstall poll
     *  (`slackReinstall`, :1073-1134), the per-bot result map. Renders its
     *  children unchanged; it is a state carrier, not chrome. */
    CardProvider: ComponentType<{ children: ReactNode }>
    /** Row action-cell controls — the refresh button with its
     *  needs-attention halo (:1295-1311), driven by the card state and the
     *  viewer's write access. */
    RowActions: ComponentType<{ bot: BotDto; canWrite: boolean }>
    /** Per-bot card banners — the refresh/reinstall outcome notice
     *  (`SlackRefreshNotice` :532-579 over the `slackRefreshNoticeState`
     *  reducer, slack/refresh-notice.ts:19-62) AND the refresh FAILURE banner
     *  beside it (:1372-1379), which is card state the host has no other way
     *  to render. Rendered under the row, outside the expanded-channels
     *  guard, exactly where both sit today. */
    CardNotice?: ComponentType<{ bot: BotDto }>
  }
  /** Wording for the two host-rendered row sentences. See
   *  {@link WebBotCardCopy}; absent ⇒ both provider-free host defaults. */
  copy?: WebBotCardCopy
}

/** One install-polling flow's public state — the exact shape of
 *  `useSlackPlatformInstall` (slack/use-platform-install.ts):
 *  mint the authorize URL, open the popup, poll the install row to a terminal
 *  state, recover when the popup is abandoned. */
export interface WebInstallPoll {
  phase: 'idle' | 'authorizing'
  err: string | null
  start(): Promise<void>
  cancel(): void
}

/**
 * Install-polling hooks consumed by host surfaces OUTSIDE the wizard — the
 * onboarding "Add to Slack" row (`AddToSlackRow`,
 * GettingStartedChecklist.tsx:282-296, rendered from GettingStarted.tsx:223
 * and OnboardingView.tsx:559). The wizard's own in-modal polls (the funnel
 * :2112-2129, the platform install :2082-2108, the Feishu registration
 * :1943-1982) stay INSIDE the Body and need no contract slot. Absent ⇒ the
 * platform offers no out-of-wizard one-click install.
 */
export interface WebInstallPollingFacet {
  useInstallPoll(agentId: string, onCompleted: () => void): WebInstallPoll
}

/**
 * Channel-list display semantics (§10) — the per-platform values
 * `IntegrationChannelList.tsx` derives from its four dispatch helpers today.
 * The kind-driven parts stay host-generic: DM/group-DM nouns and glyphs
 * (`rowNoun` :220-221, the `@`/`@@` markers :227-228) do not vary by
 * platform.
 */
export interface WebChannelListSemantics {
  /** What this platform calls a multi-member room — `'group'` (Telegram,
   *  Lark) or `'channel'` (Slack, Discord) (:217). One noun per card, by
   *  design (:209-216). */
  roomNoun: string
  /** The room row's list sigil — `'#'` where the channel convention applies,
   *  `''` where the platform has no such marker (:227-228). */
  roomGlyph: string
  /** What the bot can be made to leave from the console — the §5
   *  `leaveGranularity` mirror: `'conversation'` (Telegram `leaveChat`,
   *  :207 + :252-253), `'space'` (Discord leaves whole servers via the band
   *  heading's action, :665-668), `'none'` (Slack — scope cost, :195-201 —
   *  and Feishu). */
  leave: 'conversation' | 'space' | 'none'
  /** The sentence explaining a non-leavable room row's "Remove from this
   *  list" (:284-288) — Discord points at the band action, others at the
   *  platform's own UI. Absent ⇒ the host's generic wording with its
   *  "the chat app" fallback (:232-241). */
  cannotLeaveRowHint?: string
  /** The per-platform tail of the card footer (:786-791): Discord's
   *  servers-not-channels note, Slack's remove-it-in-Slack note (which
   *  encodes `membershipEnumeration: 'authoritative'` — the list updates by
   *  itself). Absent ⇒ no extra sentence. */
  footerNote?: string
  /**
   * Where the rows come from. `'observed'` (the default) — each row records a room the
   * bot was seen in, so it can be dropped from the list and the footer says how rows
   * appear. `'derived'` — the roster is the platform's own and the console neither adds
   * to it nor removes from it, so no row carries a way out and the footer's arrival
   * sentence is the module's {@link footerNote} instead of the host's.
   */
  roster?: 'observed' | 'derived'
  /**
   * The room row's trigger vocabulary, host order preserved. Absent ⇒ all three
   * (`off` / `any` / `mention`). A platform that emits no unaddressed traffic drops
   * `any`, because nothing would ever match it. DM rows keep their binary control.
   */
  triggers?: readonly ('off' | 'mention' | 'any')[]
  /**
   * Confirmation shown before a row's default dispatch moves OFF a RESTRICTED agent.
   * Where an owner compiles to a per-conversation default rather than an ownership
   * route, that seat is the only grant a gated agent holds in the room, so moving it
   * withdraws the grant. Absent ⇒ the move applies straight away, which is every
   * platform whose owner compiles to a route.
   */
  ownerChangeWarning?: {
    title: string
    body(ctx: { owner: string; room: string }): string
    /** Bare verb — the console's modal convention. */
    confirmLabel: string
  }
  /** The private-agent banner's sentence, where enabling a row is not the whole gate —
   *  Linear's gated member acts in a team only as its default (§4.3). Absent ⇒ the host's. */
  gatedNote?: string
  /**
   * Splits a stored row label into the name the row leads with and an optional dim tail after
   * it. Linear stores a team as `<Workspace name> / <Team name>` — a session list spanning every
   * workspace needs both — while these rows always sit under one workspace's own card, so the
   * module, never the host, knows the prefix is redundant here. Absent ⇒ the label is the name.
   */
  splitRowLabel?(label: string): { name: string; hint?: string }
}

/**
 * What one integration card on the AGENT page renders under its header, in place
 * of the host's generic conversation list.
 *
 * The generic list assumes the platform's rooms are enumerable things the bot was
 * ADDED to, each with a trigger and a way out. A module whose card has a repair of its
 * own — Linear's Reconnect, which restores a workspace grant — puts it in the header's
 * action track and keeps the rows beneath it generic.
 *
 * The host keeps the card CHROME (mark, name, connected badge, unlink) and never draws
 * a second one: the workspace name is the header's, not the body's. The Body gets the
 * integration row — which names its own agent, so there is no second prop for the
 * page's — and reaches the console data layer itself, exactly as the list does.
 */
export interface WebAgentIntegrationCardFacet {
  /** Mounts card-scope state around BOTH the header actions and the body — the
   *  {@link WebBotSettingsFragments.lifecycleActions} idiom: a state carrier, not chrome. */
  CardProvider?: ComponentType<{ integration: IntegrationRow; children: ReactNode }>
  /** Controls for the header's action track, beside the host's own unlink — Linear's
   *  Reconnect and the badge that says why it is lit. Absent ⇒ the host's actions alone. */
  HeaderActions?: ComponentType<{ integration: IntegrationRow }>
  /** `padX` lines the rows up with the host card that mounts them (16 mobile / 14
   *  desktop detail), the generic list's own prop. */
  Body: ComponentType<{ integration: IntegrationRow; padX: number }>
}

/**
 * One platform's web console module (§10). TypeScript only — registering a
 * module is one line in the (future) registry file; no host component grows a
 * platform branch.
 *
 * @typeParam TApi The module's OWN typed CP client surface — see
 *                 {@link apiBindings}. It survives the registry's erasure to
 *                 `WebPlatformModule` because it appears only in a covariant
 *                 position; see {@link WebBotSettingsFragments} for the one that
 *                 did not.
 */
export interface WebPlatformModule<TApi = unknown> {
  /** Platform id (§6.1 vocabulary). Never parsed. */
  readonly platformId: string
  /**
   * The platform's brand mark, sized by its box like today's `fillPct`
   * convention (marks.tsx:207-216). Replaces the chat arms of
   * `PlatformMark`'s substring chain (:253-263 — `.includes('tele')` and
   * friends, invisible to equality greps per the audit); the core-kind arms
   * (:217-252) and the trailing plug fallback (:265-269) stay host-owned.
   * Consumed by the picker tiles (AddIntegrationModal.tsx:2218-2220), the
   * Bots rows (SettingsView.tsx:1226-1229), the agent-page tiles
   * (AgentDetailView.tsx:1549-1551), and every transcript/rail surface that
   * routes through `PlatformMark` today.
   */
  Mark: ComponentType<{ fillPct?: number }>
  /** The install-wizard facet. Required: every chat platform is installable
   *  or it has no reason to register. */
  wizard: WebWizardFacet
  /** Settings → Bots fragments. Absent ⇒ the platform's bot rows carry no
   *  extra chrome. */
  settingsFragments?: WebBotSettingsFragments
  /**
   * The module's own typed CP client bindings — today's platform-named
   * exports of `lib/api.ts` (the eight Slack install/funnel/config calls
   * :3065-3117 plus `refreshSlackBot` :3283-3285, the Feishu registration
   * pair :3052-3059, `checkTelegramBot` :3045-3047) plus their DTO types. OPAQUE
   * to the host — no host code calls through this member; it exists so the
   * module's wizard and settings fragments share one client seam (and one
   * mock seam), and so the S4 packaging boundary is visible now. Generic,
   * platform-free calls (`createIntegration`, `leaveIntegrationConversation`
   * :3269-3274, `updateBot`) stay in `lib/api.ts`.
   *
   * The bindings NAME the calls; the fetch itself still lives in `lib/api.ts`,
   * whose `apiGet`/`apiPost` transport helpers are deliberately unexported.
   * Relocating the bodies would mean exporting that transport — widening
   * `lib/api.ts` from "the typed CP client" to "a request kit any module may
   * build on", which is a bigger contract change than this member is asking
   * for. The seam is what matters: every module-side caller goes through here,
   * so S4 can move the bodies without touching a call site. NO platform-named
   * caller remains in core: the last one, `SlackConfigCard`, was a Profile-page
   * card with nowhere to land while `settingsFragments` was the only settings
   * member and it is scoped to Settings → Bots. It now lives behind
   * {@link WebPlatformModule.ProfileCredentialCard} and reads the CP through
   * these bindings like every other surface of its module.
   */
  apiBindings: TApi
  /**
   * The signed-in USER's own provider tooling credential, as a card on the
   * Profile page — today Slack's App Configuration token
   * (`platforms/slack/profile.tsx`, docs/designs/slack-install-smoothing.md
   * §Tier B), which is what lets the install wizard create apps as YOU. The
   * host renders these in registry order (`platforms/profile.tsx`, mounted by
   * `ProfileView` in both its responsive branches); absent ⇒ the platform
   * contributes no Profile card, which is every platform but Slack.
   *
   * A member of its own rather than a `settingsFragments` sibling because the
   * two surfaces differ in SCOPE, not just in page: `settingsFragments` adorns
   * the organization's durable bot identities, while this credential is
   * per-USER (`GET/PUT/DELETE /slack/config` answers for the calling
   * principal) and belongs to no bot row at all.
   *
   * Deliberately NOT solved by {@link apiBindings}: that member is opaque to
   * the host by construction, so routing the card's three calls through it
   * would have made the host the single caller of the one member no host code
   * may call — and would have left the platform-named component itself sitting
   * in `components/console/`. What this card was missing was a HOME, not a
   * client seam.
   */
  ProfileCredentialCard?: ComponentType
  /** Out-of-wizard install polling (Slack today). */
  installPolling?: WebInstallPollingFacet
  /** Channel-list display semantics. Absent ⇒ the host defaults: `channel`
   *  noun, `#` glyph, `leave: 'none'`, generic copy. A module with its own
   *  {@link agentCard} still spends these, because that card mounts the same
   *  generic list under its chrome. */
  channelList?: WebChannelListSemantics
  /** The agent page's card body, wrapping the generic conversation list in the
   *  platform's own chrome. Absent ⇒ the bare list, which is every platform
   *  with nothing to say above its rooms. */
  agentCard?: WebAgentIntegrationCardFacet
  /**
   * Per-platform transcript text renderer — the §14 defect-3 seam, ADOPTED:
   * `MessageText` resolves it from the ROW's platform key
   * (`MergedRow.sourcePlatform`, falling back to the session's platform) on
   * every row it renders, through `platformTextRenderer` in the registry.
   *
   * NO MODULE DECLARES ONE TODAY, and that is the shipped state §10 asks for:
   * "a renderer registry keyed by platformId ships with the Slack renderer as
   * the default for all chat platforms, then per-platform overrides land
   * separately (§14)". The default is core (`SlackMrkdwnText`,
   * components/console/MessageText.tsx over `slackToMarkdown`,
   * slack-mrkdwn.ts) rather than the Slack module's member, because three
   * other platforms render through it: making it Slack's would leave Telegram,
   * Discord and Feishu reading another module's internals. It moves into
   * `platforms/slack/` on the day Slack's semantics stop being everyone's —
   * i.e. with the first override, which is also the first change here with
   * visible pixels.
   *
   * A component rather than §10's sketched `(text, ctx) => ReactNode` so the
   * memoization that keeps the transcript affordable survives the seam: the
   * transcript re-renders on every unrelated state change in
   * SessionDetailView, and `MessageText` is `memo`ized over its plain-string
   * props precisely so each row's remark pipeline does NOT re-run. A bare
   * function returning a `ReactNode` cannot be memoized by the host, and no
   * call site has a `ctx` to pass.
   */
  textRenderer?: ComponentType<{ text: string }>
  /**
   * Provider-native duplicate identity of one transcript row — the
   * per-platform arms of the merged-conversation dedupe (Slack decimal ts,
   * Discord snowflakes, Telegram short sequence ids, Feishu `om_` ids;
   * platform selects the rule via `MergeSource.platform`,
   * lib/conversation-merge.ts). `null` = this row never dedupes across
   * sources. Absent ⇒ the merge never dedupes this platform's rows — its
   * stated fail-closed direction ("toward a visible duplicate, never toward
   * data loss").
   *
   * Consumed by a CORE routine (audit Appendix D, ambiguous row 5): the merge
   * algorithm stays host-owned, and so do the two rules that are not any
   * platform's — only `kind === 'text'` rows dedupe at all, and `webchat`
   * keys on its canonical `postId`. `webchat` is not a module (it has no bot
   * identity to install), so its arm cannot move here. What the module owns is
   * the id SHAPE of its own provider.
   *
   * ADOPTED, and the "absent ⇒ never" direction is now REAL rather than
   * documentary: it used to be Slack's decimal-ts rule that ran for every
   * unrecognized platform id, because Slack was the fall-through arm of an
   * if-chain. Nothing is the fall-through now.
   */
  messageIdentity?(row: SessionMessageDto): string | null
  /**
   * Whether transcript pages re-sort by event time or trust the daemon
   * sequence — the `platform !== 'slack'` fork `mergeSessionMessages`
   * (lib/session-transcript.ts) used to spell out: Slack rows carry provider
   * send-times that the display order must follow; everyone else orders by
   * `seq`. Absent ⇒ `'seq'`, which is both the conservative arm and the arm
   * every non-Slack platform already took, so ADOPTING this member moved the
   * fork without moving the behavior.
   */
  transcriptOrdering?: 'seq' | 'event-time'
}

/**
 * The registry shape the console composes — the single platform-set authority
 * of the S3 exit criterion, replacing the hand-copied closed unions and lists:
 * the modal's `BotPlatform` union + `BOT_PLATFORMS` (AddIntegrationModal.tsx:
 * 85-105, re-imported by AgentDetailView), the Bots-card tab list
 * (SettingsView.tsx:369-375 — which also encodes the region axis and stays a
 * host projection OVER the registry), and the create-input union's member set
 * (api.ts:654-672). Deliberately an interface (the S2/S3 seam-first
 * precedent): the concrete registry lands with the first module move, not
 * with the contract.
 */
export interface WebPlatformRegistry {
  get(platformId: string): WebPlatformModule | undefined
  all(): readonly WebPlatformModule[]
  /** Chat-platform ids in picker order. webhook/github are NOT here — they
   *  are core wizard sections, not modules (see the module doc). */
  ids(): readonly string[]
}
