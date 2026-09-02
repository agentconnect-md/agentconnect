/**
 * **Layer-1 read ports** — which optional facets of the connection contract a
 * platform offers, and how core asks (integration-plugin-architecture.md §7.1 /
 * §7.4, audit Appendix A class a, stage S3).
 *
 * `contract.ts` already declares the optional half of {@link PlatformConnection}
 * — `getThreadReplies`, `openDirectMessage`, `listBotChannels`, … — and the audit
 * calls the `typeof conn?.x === 'function'` probe over them "the sanctioned
 * Layer-1 read-port mechanism". What was missing is the OTHER half of the same
 * question, asked where no connection is in hand yet: *does this PLATFORM offer
 * the port at all?* The MCP tool surface asks it in three places, and each
 * spelled the answer as a platform name:
 *
 *  - which agent-facing attachment tool to inject (`platform === 'slack'` →
 *    `readSlackFile`, `=== 'telegram'` → `readTelegramFile`) — decided at
 *    `session/new` from the agent's CONFIGURED integrations, long before any
 *    connection is resolved;
 *  - which platform a `toUser` direct message defaults to (`?? 'slack'`);
 *  - whether the selected platform can open a DM at all (`!== 'slack'` → throw).
 *
 * TWO ASKS, ON PURPOSE. {@link offersReadPort} probes a live bearer (a
 * connection, or the `MessageGateway` slice the MCP tools hold); the registry
 * below answers for a platform id before one exists. They are not redundant: the
 * probe is the truth about THIS connection, the declaration is what core may
 * assume while building a tool list for an agent whose bots may all be offline.
 * Deciding tool injection by live probe would silently drop `readSlackFile` from
 * a session opened while the socket was reconnecting — a behavior change this
 * refactor is not allowed to make.
 *
 * FAIL-CLOSED BY ABSENCE, like `messageOrderingFor`. An unregistered platform
 * declares no ports: no attachment tool is injected, no DM is attempted. That is
 * exactly the old `else` arm of every branch above, and it means a new platform
 * degrades quietly instead of inheriting a Slack-shaped path it cannot serve.
 *
 * TOOL NAMES ARE FROZEN. `readSlackFile` / `readTelegramFile` are names agents
 * have learned and examples teach; the injection MECHANISM generalizes, the
 * names do not move. They live in their platform's own module now, which is the
 * whole point — core no longer knows that either name exists.
 */
import type { ZodType } from 'zod'
import type { SessionContext } from '../mcp/ops/context.js'
import type { ReplyAttributionInfo } from '../messages/attribution.js'
import type { ToolDescriptor } from '../tool-schema/descriptor.js'
import { LINEAR_SESSION_TOOLS } from './linear/agent-tools.js'
import { SLACK_ATTACHMENT_TOOL } from './slack/attachments.js'
import { TELEGRAM_ATTACHMENT_TOOL } from './telegram/attachments.js'

/** The optional {@link import('./contract.js').PlatformConnection} facets core
 *  branches on. A port earns a name
 *  here when a branch retires onto it, never speculatively. */
export type ReadPort = 'getThreadReplies' | 'openDirectMessage' | 'getChannelHistory'

/** Anything that MAY carry read ports: a real connection, the `MessageGateway`
 *  slice the MCP tools hold, or a duck-typed test fake. Deliberately `object`
 *  and not `Partial<Record<ReadPort, unknown>>` — the latter is a WEAK type, so
 *  TypeScript rejects exactly the connections that implement no optional port
 *  (`TelegramConnection` "has no properties in common"), which is the arm this
 *  probe exists to answer `false` for. */
export type ReadPortBearer = object

/** Does this bearer implement `port`? The typed home for the
 *  `typeof conn?.getThreadReplies === 'function'` probes core grew organically.
 *  A missing bearer answers false, so callers keep their one-line gate. */
export function offersReadPort(bearer: ReadPortBearer | undefined, port: ReadPort): boolean {
  return typeof (bearer as Partial<Record<ReadPort, unknown>> | undefined)?.[port] === 'function'
}

/**
 * A platform's OWN agent tools — descriptors, their validators, and the dispatch — injected
 * only into a session ON that platform and executed through that session's connection. The
 * seat for a platform-shaped tool family (an issue tracker's reads and writes) that no port on
 * the chat contract describes; core learns the names from here and nothing else.
 */
export interface PlatformSessionTools {
  readonly descriptors: readonly ToolDescriptor[]
  /** The dispatch-boundary validator per tool name; the parity test holds both sides together. */
  readonly argSchemas: ReadonlyMap<string, ZodType>
  execute(
    name: string,
    ctx: SessionContext,
    args: Record<string, unknown>,
    env: PlatformSessionToolEnv
  ): Promise<unknown>
}

/** What a session tool acts through beyond its own arguments — daemon facts, never model input. */
export interface PlatformSessionToolEnv {
  /** The session's own live platform connection (`sessionToolConnectionFor`). */
  readonly connection: unknown
  /** This turn's footer identity, for a tool that publishes text the agent must be named on.
   *  Lazy because most tools never render it; undefined when the agent's footer chrome is off. */
  readonly attribution?: () => Promise<ReplyAttributionInfo | undefined>
}

/** One platform's read-port declaration — the pre-connection half of the ask. */
export interface PlatformReadPorts {
  /** Platform id this declaration answers for; never parsed. */
  readonly platform: string
  /** Human-facing name, for errors that must stay as informative as the
   *  hardcoded ones they replace ("only supported on Slack"). */
  readonly label: string
  /** Layer-1 `openDirectMessage`: this platform's connections can resolve a user
   *  id to the app's own 1:1 conversation, so `sendMessage`'s `toUser` form has
   *  somewhere to post. */
  readonly openDirectMessage?: boolean
  /** The agent-facing channel history tool backed by this platform's cursor API. */
  readonly channelHistory?: boolean
  /** `getThreadReplies`: the root + replies of one thread can be read on demand. */
  readonly threadHistory?: boolean
  /** `addReaction` / `getReactions`: arbitrary emoji, not just the turn-chrome intent. */
  readonly reactions?: boolean
  /** `searchPublicMessages`: the platform offers a workspace search this bot identity may run. */
  readonly publicMessageSearch?: boolean
  /** `createConversation`: the bot may create a channel or open a group conversation. */
  readonly conversationCreate?: boolean
  /** `scheduleMessage`: the platform accepts a message for later delivery. */
  readonly scheduledMessages?: boolean
  /** `createCanvas` / `readCanvas` / `updateCanvas`: a platform-hosted rich-text page. */
  readonly canvas?: boolean
  /** `listBookmarks` / `addBookmark` / `removeBookmark`: the platform pins links in a channel. */
  readonly bookmarks?: boolean
  /** `readList` / `addListItem` / `updateListItem`: the platform hosts structured lists. */
  readonly lists?: boolean
  /** The agent-facing tool that surfaces this platform's CREDENTIALED attachment
   *  read. Present when the platform's file references cannot be fetched without
   *  the bot token, so the agent needs a tool instead of its own network access.
   *
   *  Absent is not "no attachments": Discord hands out directly fetchable CDN
   *  links, and Feishu simply never grew a tool. Giving Feishu one is now a
   *  registration in its own module rather than a third `platform === …` arm in
   *  `mcp/tools.ts`. */
  readonly attachmentReadTool?: ToolDescriptor
  /** The platform's own session-scoped tool family, when it has one. */
  readonly sessionTools?: PlatformSessionTools
}

/**
 * A `Map`, not an object literal, so lookup is total for EVERY string rather
 * than every string that is not an `Object.prototype` key — the same fail-closed
 * reasoning the §5 manifest registry and `messageOrderingFor` carry.
 *
 * Insertion order is the ORDER CORE EMITS IN: `attachmentReadToolsFor` walks the
 * registry, not the agent's integration list, so an agent's tool list does not
 * reshuffle because its integrations were stored in a different order.
 */
const READ_PORTS = new Map<string, PlatformReadPorts>([
  [
    'slack',
    {
      platform: 'slack',
      label: 'Slack',
      openDirectMessage: true,
      channelHistory: true,
      threadHistory: true,
      reactions: true,
      conversationCreate: true,
      publicMessageSearch: true,
      scheduledMessages: true,
      canvas: true,
      bookmarks: true,
      lists: true,
      attachmentReadTool: SLACK_ATTACHMENT_TOOL
    }
  ],
  [
    'telegram',
    {
      platform: 'telegram',
      label: 'Telegram',
      attachmentReadTool: TELEGRAM_ATTACHMENT_TOOL
    }
  ],
  [
    'discord',
    {
      platform: 'discord',
      label: 'Discord',
      channelHistory: true
    }
  ],
  [
    'feishu',
    {
      platform: 'feishu',
      label: 'Lark / Feishu',
      channelHistory: true
    }
  ],
  [
    'linear',
    {
      platform: 'linear',
      label: 'Linear',
      sessionTools: LINEAR_SESSION_TOOLS
    }
  ]
])

/** `platform`'s declaration, or undefined when it declares no read ports. */
export function readPortsFor(platform: string): PlatformReadPorts | undefined {
  return READ_PORTS.get(platform)
}

/** `platform`'s human-facing name, falling back to the raw id so an unknown
 *  platform still names itself in an error rather than reading as blank. */
export function platformLabel(platform: string): string {
  return READ_PORTS.get(platform)?.label ?? platform
}

/** Can `platform` open a direct message (Layer-1 `openDirectMessage`)? */
export function offersDirectMessages(platform: string): boolean {
  return READ_PORTS.get(platform)?.openDirectMessage === true
}

/**
 * The platform a `toUser` send targets when the caller names none.
 *
 * Prefers the session's own platform when it can open a DM, else the first
 * platform that can. With Slack the only DM-capable platform this is exactly the
 * `directMessage ? 'slack' : ctx.platform` literal it replaces — including for a
 * session on a platform that cannot DM, which still resolves to the DM-capable
 * one and then fails on the caller's own "no Slack integration" error.
 *
 * A session platform that declares nothing and no DM-capable platform at all
 * falls back to the session's platform: the caller's ordinary
 * "not supported on X" error is the right report, not a silent redirect.
 */
export function directMessagePlatformFor(sessionPlatform: string): string {
  if (offersDirectMessages(sessionPlatform)) return sessionPlatform
  for (const decl of READ_PORTS.values()) if (decl.openDirectMessage) return decl.platform
  return sessionPlatform
}

/** The DM-capable platforms, rendered for an error message ("Slack",
 *  "Slack or Telegram"). Empty when no platform declares the port. */
export function directMessagePlatformList(): string {
  const labels = [...READ_PORTS.values()].filter((d) => d.openDirectMessage).map((d) => d.label)
  return labels.join(' or ')
}

/** Every platform's attachment tool, in registry order — the permission
 *  auto-allow set must list every injectable name, whatever the agent has. */
export function allAttachmentReadTools(): ToolDescriptor[] {
  return [...READ_PORTS.values()].flatMap((d) => (d.attachmentReadTool ? [d.attachmentReadTool] : []))
}

/** The attachment tools for exactly the platforms an agent is connected to, in
 *  registry order. A platform that declares none contributes nothing. */
export function attachmentReadToolsFor(platforms: Iterable<string>): ToolDescriptor[] {
  const wanted = new Set(platforms)
  return [...READ_PORTS.values()].flatMap((d) =>
    wanted.has(d.platform) && d.attachmentReadTool ? [d.attachmentReadTool] : []
  )
}

/** The declaration flags that gate ONE agent-facing tool each — the ports whose only
 *  question is "does this platform have it?", answered before a connection exists. */
export type PlatformToolPort =
  | 'channelHistory'
  | 'threadHistory'
  | 'reactions'
  | 'conversationCreate'
  | 'publicMessageSearch'
  | 'scheduledMessages'
  | 'canvas'
  | 'bookmarks'
  | 'lists'

/** Does `platform` declare `port`? The session-platform gate every port-gated tool sits
 *  behind: a tool is injected for a session ON a declaring platform, never reached across. */
export function declaresPort(platform: string, port: PlatformToolPort): boolean {
  return READ_PORTS.get(platform)?.[port] === true
}

/** Every registered platform, in registry order. Building the tool list against this
 *  passes every port gate, which is what the permission auto-allow set needs. */
export function allPortPlatforms(): string[] {
  return [...READ_PORTS.keys()]
}

/** Is `name` some platform's attachment-read tool? The MCP dispatcher runs ONE
 *  shared body for all of them — the platform contributes only the descriptor,
 *  the download itself is the Layer-1 `downloadFile` every connection has. */
export function isAttachmentReadTool(name: string): boolean {
  for (const decl of READ_PORTS.values()) if (decl.attachmentReadTool?.name === name) return true
  return false
}

/** The session-scoped tool family of `platform`, when it declares one. */
export function sessionToolsFor(platform: string | undefined): PlatformSessionTools | undefined {
  return platform === undefined ? undefined : READ_PORTS.get(platform)?.sessionTools
}

/** Every platform's session tools, in registry order — the permission auto-allow set needs
 *  the names an agent will only ever see on one platform. */
export function allSessionToolDescriptors(): ToolDescriptor[] {
  return [...READ_PORTS.values()].flatMap((d) => [...(d.sessionTools?.descriptors ?? [])])
}

/** The platform whose session tools include `name`, for the dispatcher's call-time gate. */
export function sessionToolOwner(name: string): PlatformReadPorts | undefined {
  for (const decl of READ_PORTS.values()) {
    if (decl.sessionTools?.descriptors.some((t) => t.name === name)) return decl
  }
  return undefined
}
