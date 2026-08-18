/**
 * The webchat conversation fixture — ONE multi-agent webchat conversation at
 * the daemon seam, for the night-collection scenario and webchat Werewolf.
 *
 * This is the same seam PR #906's tests and the parity webchat leg drive
 * (`packages/daemon/test/webchat-continuation-fixture.ts`): `handleRelayMsg`
 * fed the relay's pre-addressed `turn` frames, with the §5.2 roster fan-out of
 * committed posts played by the fixture — no relay process, no platform SDKs,
 * no credentials. What this fixture ADDS over the continuation fixture:
 *
 *  - **UUID agent ids** (with an alias map for readability), because several
 *    production branches key on `UUID_RE.test(msg.sender.id)` — most notably
 *    #926's live posting of an agent-initiated wake's INBOUND message. The
 *    live composition uses UUID agent ids, so a faithful eval must too.
 *  - the **evaluation observer** (`turn.*` / `acp.update` events), which is
 *    how a REAL-subject run — where there is no in-process prompt log — still
 *    yields per-turn input evidence for reply-loss accounting.
 *  - subject preparation for both compositions: a scripted root (in-process
 *    hosts, the CI gate) and a real root (template runtimes for the players +
 *    the puppet ACP adapter for the scripted referee).
 *
 * The Slack-shaped games keep `evals/games/{world,topology}.ts`; nothing here
 * touches them. This fixture is deliberately conversation-shaped instead of
 * room-shaped: webchat has ONE conversation, no channels, and its private legs
 * are postless `toAgent` calls rather than private rooms.
 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Daemon } from '../../packages/daemon/src/daemon.js'
import {
  EvaluationEventCollector,
  collectObjectSecrets,
  compositeEvaluationObserver,
  environmentSecrets
} from '../../packages/daemon/src/evaluation/index.js'
import { transcriptChannelKey } from '../../packages/daemon/src/store/local-store.js'
import { selectTurnTargets } from '../../packages/relay/src/relay-browser-connection.js'
import type { EvaluationEvent } from '../../packages/daemon/src/evaluation/index.js'
import type { RdMsgWebchat, RdWebchatPost, WebchatPost } from '../../packages/protocol/src/index.js'

/** The standing response-choice sentinel (product-conventions §No-response). */
export const NO_RESPONSE = 'AC_NO_RESPONSE'

export interface WebchatSeat {
  /** Human-readable seat name (referee / player-1 / …) — used in transcripts,
   *  policies, and reports. */
  alias: string
  /** UUID agent id, minted per run. The daemon only ever sees this. */
  agentId: string
}

/** Mint the roster: UUID agent ids behind stable aliases. */
export function mintSeats(aliases: readonly string[]): WebchatSeat[] {
  return aliases.map((alias) => ({ alias, agentId: randomUUID() }))
}

export interface ScriptedWebchatRootOptions {
  /** Extra config.json fields merged at the top level. */
  config?: Record<string, unknown>
}

/** Scaffold a control-plane-less daemon root with one stub agent per seat.
 *  Mirrors the continuation fixture's scaffold, with the turn-final refresh
 *  feature ON (the #906 behavior the scenario depends on). */
export function prepareScriptedWebchatRoot(seats: readonly WebchatSeat[], options: ScriptedWebchatRootOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ac-webchat-arena-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      features: { turnFinalContextRefresh: true },
      runtimes: { scripted: { command: 'node', args: ['unused'] } },
      ...(options.config ?? {})
    })
  )
  for (const seat of seats) {
    const agentDir = join(root, 'agents', seat.agentId)
    mkdirSync(agentDir, { recursive: true, mode: 0o700 })
    writeFileSync(
      join(agentDir, 'agent.json'),
      JSON.stringify({
        id: seat.agentId,
        name: seat.alias,
        status: 'active',
        runtime: 'scripted',
        workspace: { mode: 'from-scratch', path: join(agentDir, 'workspace') },
        integrations: [],
        output: { mode: 'low', showFooter: false, showStatusBar: false }
      })
    )
  }
  return { root, secrets: [] as string[], cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

export interface RealWebchatRootOptions {
  /** Template root: config.json (explicit runtimes) + agents/<id>/agent.json. */
  subjectRoot: string
  /** Template agent ids mapped onto the PLAYER seats in order (broadcast when
   *  a single id is given) — the referee seat never consumes one. */
  templateAgentIds: string[]
  /** The seat played by the scripted referee (puppet ACP adapter). */
  refereeAlias: string
  /** Unix-socket endpoint of the puppet driver (see `puppet.ts`). */
  puppetEndpoint: string
}

function assertNotSymlink(path: string, label: string): void {
  if (lstatSync(path).isSymbolicLink()) throw new Error(`${label} may not be a symbolic link`)
}

/**
 * Disposable REAL webchat subject: player seats materialized from the
 * operator's template (real runtimes, real provider credentials — the
 * collaboration-arena-baseline §4.1 recipe), the referee seat bound to the
 * puppet ACP adapter so its brain stays deterministic while acting through the
 * REAL tool surface. Control plane, relays, crons, integrations stripped;
 * memory off; from-scratch workspaces; template secrets harvested for
 * redaction. Mirrors `prepareRealSubject` (evals/games/subject.ts) minus the
 * compiled Slack topology, which webchat does not have.
 */
export function prepareRealWebchatRoot(seats: readonly WebchatSeat[], options: RealWebchatRootOptions) {
  const sourceRoot = resolve(options.subjectRoot)
  const configPath = join(sourceRoot, 'config.json')
  if (!existsSync(configPath)) throw new Error(`webchat subject template is missing ${configPath}`)
  if (options.templateAgentIds.length === 0) throw new Error('real webchat subject requires a templateAgentId')
  const root = mkdtempSync(join(tmpdir(), 'ac-webchat-real-'))
  const cleanup = () => rmSync(root, { recursive: true, force: true })
  try {
    assertNotSymlink(configPath, 'webchat subject config')
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
    const secrets = collectObjectSecrets(config)
    const runtimes =
      config.runtimes && typeof config.runtimes === 'object' && !Array.isArray(config.runtimes)
        ? (config.runtimes as Record<string, unknown>)
        : {}
    writeFileSync(
      join(root, 'config.json'),
      `${JSON.stringify(
        {
          ...config,
          daemonId: undefined,
          agentsDir: join(root, 'agents'),
          controlPlane: { enabled: false },
          relays: [],
          features: { turnFinalContextRefresh: true },
          security: {
            ...(config.security && typeof config.security === 'object' ? (config.security as object) : {}),
            isolateAccountApps: true
          },
          runtimes: {
            ...runtimes,
            'ac-puppet': {
              command: process.execPath,
              args: [resolve(process.cwd(), 'evals', 'games', 'puppet-acp-agent.mjs')],
              env: [{ name: 'AC_PUPPET_ENDPOINT', value: options.puppetEndpoint }]
            }
          }
        },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    )
    const players = seats.filter((seat) => seat.alias !== options.refereeAlias)
    for (const [index, seat] of players.entries()) {
      const templateId = options.templateAgentIds[index % options.templateAgentIds.length]!
      if (templateId === '.' || templateId === '..' || /[/\\\0]/.test(templateId)) {
        throw new Error(`webchat subject template agent id is not a safe path segment: ${JSON.stringify(templateId)}`)
      }
      const sourceAgentPath = join(sourceRoot, 'agents', templateId, 'agent.json')
      if (!existsSync(sourceAgentPath)) throw new Error(`webchat subject template has no agent "${templateId}"`)
      const template = JSON.parse(readFileSync(sourceAgentPath, 'utf8')) as Record<string, unknown>
      collectObjectSecrets(template, '', secrets)
      if (typeof template.runtime !== 'string' || !Object.prototype.hasOwnProperty.call(runtimes, template.runtime)) {
        throw new Error(`webchat subject agent "${templateId}" requires an explicit runtime definition in config.json`)
      }
      writeSeatAgent(root, seat, { ...template })
    }
    const referee = seats.find((seat) => seat.alias === options.refereeAlias)
    if (!referee) throw new Error(`no seat named "${options.refereeAlias}" for the referee`)
    // `none` memory needs a runtime-verified off-switch, which the puppet
    // adapter (an unregistered runtime) cannot offer — `managed` is our own
    // no-op-for-the-adapter store and the evaluation profile keeps memory off.
    writeSeatAgent(root, referee, { runtime: 'ac-puppet' }, 'managed')
    return {
      root,
      secrets: [...new Set([...secrets, ...environmentSecrets()].filter((secret) => secret.length >= 4))],
      cleanup
    }
  } catch (error) {
    cleanup()
    throw error
  }
}

function writeSeatAgent(
  root: string,
  seat: WebchatSeat,
  template: Record<string, unknown>,
  memoryProvider: 'none' | 'managed' = 'none'
): void {
  const agentDir = join(root, 'agents', seat.agentId)
  mkdirSync(agentDir, { recursive: true, mode: 0o700 })
  const workspacePath = join(agentDir, 'workspace')
  mkdirSync(workspacePath, { recursive: true, mode: 0o700 })
  const prepared = {
    ...template,
    id: seat.agentId,
    name: seat.alias,
    displayName: seat.alias,
    status: 'active',
    pause: false,
    integrations: [],
    crons: [],
    mcpServers: [],
    memory: { provider: memoryProvider },
    workspace: { mode: 'from-scratch', path: workspacePath, gitBranch: 'main', pullOnNewSession: true, skills: [] },
    output: { mode: 'low', showFooter: false, showStatusBar: false }
  }
  writeFileSync(join(agentDir, 'agent.json'), `${JSON.stringify(prepared, null, 2)}\n`, { mode: 0o600 })
}

export interface WebchatArenaOptions {
  root: string
  seats: readonly WebchatSeat[]
  conversationId?: string
  hostFactory?: NonNullable<ConstructorParameters<typeof Daemon>[0]>['hostFactory']
  runId?: string
  secrets?: readonly string[]
}

/** The webchat user who plays the HOST in the conversation. */
export const HOST_USER = 'owner'

/**
 * One booted daemon + the fixture playing the relay for ONE conversation:
 * pre-addressed `turn` frames for the host's posts, and the §5.2 fan-out of
 * every committed `rd/webchat-post` (a `context` copy to each other roster
 * member). `posts` is the browser's view of the conversation.
 */
export class WebchatArena {
  readonly daemon: Daemon
  readonly conversationId: string
  readonly posts: RdWebchatPost[] = []
  private readonly collector: EvaluationEventCollector
  private readonly seatByAlias = new Map<string, WebchatSeat>()
  private readonly seatById = new Map<string, WebchatSeat>()
  private turnSeq = 0
  private started = false

  constructor(private readonly options: WebchatArenaOptions) {
    this.conversationId = options.conversationId ?? randomUUID()
    this.collector = new EvaluationEventCollector(options.secrets)
    for (const seat of options.seats) {
      this.seatByAlias.set(seat.alias, seat)
      this.seatById.set(seat.agentId, seat)
    }
    this.daemon = new Daemon({
      root: options.root,
      evaluation: {
        observer: compositeEvaluationObserver(this.collector),
        runId: options.runId ?? randomUUID(),
        capabilityProfile: { memory: 'off' }
      },
      probeRuntimes: async () => [],
      ...(options.hostFactory ? { hostFactory: options.hostFactory } : {})
    })
  }

  seat(alias: string): WebchatSeat {
    const seat = this.seatByAlias.get(alias)
    if (!seat) throw new Error(`no webchat seat named "${alias}"`)
    return seat
  }

  aliasOf(agentId: string): string {
    return this.seatById.get(agentId)?.alias ?? agentId
  }

  async start(): Promise<void> {
    if (this.started) return
    await this.daemon.start()
    this.started = true
    // The flat org directory: every roster pair may call every other (the
    // `admits()` check runs per continuation edge and per agent call).
    ;(this.daemon as any).cpCollab.replace({
      generation: 1,
      channels: [],
      agents: this.options.seats.map((seat) => ({
        agentId: seat.agentId,
        orgId: 'org-webchat-arena',
        callPolicy: 'all',
        allowedCallerAgentIds: [],
        outboundPolicy: 'all',
        allowedTargetAgentIds: []
      }))
    })
    ;(this.daemon as any).relays = { sendWebchatPost: (post: RdWebchatPost) => this.fanOut(post), stop: async () => {} }
  }

  /** Play the relay: record the committed post and fan a pre-addressed
   *  `context` copy to every OTHER roster member (webchat-multi-agents §5.2). */
  private ctxSeq = 0
  fanOut(post: RdWebchatPost): void {
    this.posts.push(post)
    for (const seat of this.options.seats) {
      if (seat.agentId === post.agentId) continue
      void (this.daemon as any).handleRelayMsg(
        this.rd({ op: 'context', post: post.post }, { agentId: seat.agentId, msgId: `ctx-${this.ctxSeq++}` }),
        () => {}
      )
    }
  }

  private rd(payload: RdMsgWebchat['payload'], over: Partial<RdMsgWebchat> = {}): RdMsgWebchat {
    return {
      source: 'webchat',
      agentId: over.agentId ?? this.options.seats[0]!.agentId,
      sessionKey: this.conversationId,
      msgId: over.msgId ?? `m-${this.turnSeq}`,
      chatId: this.conversationId,
      payload,
      ...over
    }
  }

  /**
   * The HOST posts into the conversation: the relay's §5.2 user-turn fan-out
   * for the target set the PRODUCTION choice (`selectTurnTargets`) computes —
   * a pre-addressed `turn` frame per target, a transcript-only user `context`
   * copy to every other roster member. `mentions` narrows by seat alias.
   */
  async postHost(text: string, options: { mentions?: string[] } = {}): Promise<{ postId: string }> {
    const postId = randomUUID()
    const at = Date.now()
    const seq = ++this.turnSeq
    const roster = this.options.seats.map((seat) => seat.agentId)
    const mentionIds = options.mentions?.map((alias) => this.seat(alias).agentId)
    const chosen = selectTurnTargets(roster, mentionIds ? { mentions: mentionIds } : {})
    if (chosen.invalid.length > 0) throw new Error(`postHost: invalid mention targets ${chosen.invalid.join(', ')}`)
    for (const [index, agentId] of chosen.valid.entries()) {
      const result = await (this.daemon as any).handleRelayMsg(
        this.rd(
          {
            op: 'turn',
            text,
            user: HOST_USER,
            turnId: postId,
            ...(mentionIds !== undefined ? { mentions: mentionIds } : {}),
            post: { postId, at }
          },
          { agentId, msgId: `turn-${seq}-t${index}` }
        ),
        () => {},
        (post: RdWebchatPost) => this.fanOut(post)
      )
      if (!result || result.accepted !== true) {
        throw new Error(`postHost: turn frame for ${this.aliasOf(agentId)} was not accepted`)
      }
    }
    const userPost: WebchatPost = {
      postId,
      conversationId: this.conversationId,
      author: { kind: 'user', user: HOST_USER },
      text,
      at
    }
    for (const [index, agentId] of roster.filter((id) => !chosen.valid.includes(id)).entries()) {
      await (this.daemon as any).handleRelayMsg(
        this.rd({ op: 'context', post: userPost }, { agentId, msgId: `turn-${seq}-c${index}` }),
        () => {}
      )
    }
    // The host's own post is part of the conversation view too.
    this.posts.push({ conversationId: this.conversationId, agentId: 'host', post: userPost } as RdWebchatPost)
    return { postId }
  }

  events(): readonly EvaluationEvent[] {
    return this.collector.events()
  }

  eventCollector(): EvaluationEventCollector {
    return this.collector
  }

  /** Committed conversation posts authored by agents (the browser's view minus
   *  the host's own posts). */
  agentPosts(): RdWebchatPost[] {
    return this.posts.filter((post) => post.agentId !== 'host')
  }

  /** Shared-conversation transcript rows (what a peer's context refresh reads). */
  transcriptRows(): Promise<{ sender: string; text: string }[]> {
    return (this.daemon as any).store.transcriptSince(
      transcriptChannelKey(this.conversationId, undefined),
      `webchat:${this.conversationId}`,
      null
    ) as Promise<{ sender: string; text: string }[]>
  }

  /**
   * Settle: wait until the daemon reports evaluation idleness AND no new
   * evaluation events have landed for `quietMs`. Cascades (fan-out wakes, MCP
   * calls mid-turn, reply wakes) all surface as events, so a quiet window on
   * top of the idle barrier is what "the night has fully drained" means here.
   */
  async settle(options: { quietMs?: number; timeoutMs?: number } = {}): Promise<void> {
    const quietMs = options.quietMs ?? 700
    const timeoutMs = options.timeoutMs ?? 60_000
    const deadline = Date.now() + timeoutMs
    let lastCount = -1
    let quietSince = Date.now()
    while (Date.now() < deadline) {
      await this.daemon.waitForEvaluationIdle(Math.max(1_000, deadline - Date.now()))
      const count = this.collector.events().length
      if (count !== lastCount) {
        lastCount = count
        quietSince = Date.now()
      } else if (Date.now() - quietSince >= quietMs) {
        return
      }
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 100))
    }
    throw new Error(`webchat arena did not settle within ${timeoutMs}ms`)
  }

  /** Like {@link settle} but never throws — a real-model run that stalls is a
   *  RESULT, not an error. Returns whether it settled. */
  async settleOrStall(options: { quietMs?: number; timeoutMs?: number } = {}): Promise<boolean> {
    try {
      await this.settle(options)
      return true
    } catch {
      return false
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return
    this.started = false
    await this.daemon.stop()
  }
}

// ── reply-wake evidence ─────────────────────────────────────────────────────

const BARE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * The daemon-side admission evidence for `sendMessage {sessionId}` reply wakes
 * into one agent's sessions — what lets a scorer tell "the reply's wake was
 * admitted (and either started a turn or was coalesced into one)" apart from
 * "the reply's body merely became VISIBLE somewhere" (which, under #926, any
 * committed public copy can do via a later, unrelated context refresh).
 *
 * The discriminator: a reply wake's evaluation `turnId` is
 * `<agentId>:<deliveryId>` with a BARE-UUID deliveryId and `source: 'agent'`
 * at admission. The other webchat wake shapes cannot collide — a §5.2a
 * continuation wake's id is `<postId>#<target>` (never a bare UUID), a host
 * user turn is `source: 'user'`, and a `messageAgent` call's deliveryId is a
 * monotonic timestamp. Validated against real-run artifacts: the stage-2
 * Werewolf game shows exactly one accepted id per answered needsReply call,
 * and the all-lost night-collection trials show zero.
 */
export interface ReplyWakeEvidence {
  /** Reply-wake deliveryIds ADMITTED into the agent's sessions. */
  accepted: Set<string>
  /** Turn inputs of reply wakes that STARTED their own turn, by deliveryId. */
  startedInputs: Map<string, string>
  /** Reply-wake deliveryIds whose queued activation was COALESCED into an
   *  in-flight turn (the turn's refreshed input represents the reply). */
  coalesced: Set<string>
}

export function agentReplyWakeEvidence(events: readonly EvaluationEvent[], agentId: string): ReplyWakeEvidence {
  const suffixOf = (event: EvaluationEvent): string | undefined => {
    if (event.agentId !== agentId || typeof event.turnId !== 'string') return undefined
    const prefix = `${agentId}:`
    if (!event.turnId.startsWith(prefix)) return undefined
    const suffix = event.turnId.slice(prefix.length)
    return BARE_UUID.test(suffix) ? suffix : undefined
  }
  const accepted = new Set<string>()
  for (const event of events) {
    if (event.type !== 'turn.accepted' || event.data.source !== 'agent') continue
    const suffix = suffixOf(event)
    if (suffix !== undefined) accepted.add(suffix)
  }
  const startedInputs = new Map<string, string>()
  const coalesced = new Set<string>()
  for (const event of events) {
    const suffix = suffixOf(event)
    if (suffix === undefined || !accepted.has(suffix)) continue
    if (event.type === 'turn.started') startedInputs.set(suffix, String(event.data.input ?? ''))
    if (event.type === 'turn.cancelled' && event.data.reason === 'coalesced_into_turn') coalesced.add(suffix)
  }
  return { accepted, startedInputs, coalesced }
}
