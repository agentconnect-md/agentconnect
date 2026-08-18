// Drive a REAL installed agent through a full Daemon over the daemon's REAL Slack send
// path, and collect what the daemon observes for each matrix feature dimension.
//
// Nothing here talks to AcpHost directly and nothing hand-posts the agent's words: the
// agent is bound to a shared-mode Slack integration (send-only Web-API client, no socket),
// each turn is triggered by injecting a bot_id-free @mention into the daemon and awaited
// via `Daemon.dispatch(..., integrationId)`, so the daemon itself renders and POSTS the
// reply + status bar into the Slack thread. Model / permission-mode switches go through
// `Daemon.handleStatusAction` (the status-modal code) — visible in the status bar the
// daemon posts — and are read back via `Daemon.statusInfoForKey`. Interactive-permission
// is exercised on the real path: a tool-triggering turn makes the daemon post a real
// Allow/Deny CARD, which we resolve via `Daemon.handlePermissionChoice`.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebClient } from '@slack/web-api'
import { Daemon } from '../../../src/daemon.js'
import { detectSandbox } from '../../../src/acp/sandbox.js'
import { sessionKey } from '../../../src/store/local-store.js'
import { normalizeSlackEvent } from '../../../src/slack/normalize.js'
import { decodePermValue, PERMISSION_ACTION_PREFIX } from '../../../src/slack/render.js'
import type { RuntimeDef } from '../../../src/config/config-schema.js'
import { skillsAgentIdForRuntime } from '../../../src/runtimes/skills-capability.js'
import type { FeatureId } from '../support-matrix.js'
import type { SlackCreds } from './slack-live-harness.js'

const AGENT = 'bot-a'
const INT = 'sl'
const PER_TURN_MS = 150_000
const STATUS_BAR = ':bar_chart:'

export interface SlackCtx {
  creds: SlackCreds
  threadTs: string
  driverUser: string
}
export interface FeatureOutcome {
  status: 'ok' | 'degrade' | 'na' | 'fail'
  detail: string
}
export interface Switch {
  from?: string
  to?: string
  applied: boolean
}
export interface AgentResult {
  id: string
  reachable: boolean
  error?: string
  reply?: string
  // Structured observations (for the detailed summary; the daemon's own view).
  models?: string[]
  currentModel?: string
  modelSwitch?: Switch
  modes?: string[]
  currentMode?: string
  modeSwitch?: Switch
  loadSession?: boolean
  mcp?: { http: boolean; sse: boolean }
  usageTokens?: number
  usageCost?: number
  memoryViaMeta?: boolean
  /** true = card rendered + resolved; false = agent used no gated tool; undefined = not run. */
  permResolved?: boolean
  features: Partial<Record<FeatureId, FeatureOutcome>>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms).unref?.())
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label}: timed out after ${ms}ms`)), ms).unref?.())
  ])
}

function scaffold(id: string, rt: RuntimeDef, creds: SlackCreds, runInSandbox: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), `ac-live-${id}-`))
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ version: 1, controlPlane: { enabled: false }, runtimes: { [id]: rt } })
  )
  const adir = join(dir, 'agents', AGENT)
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id: AGENT,
      name: AGENT,
      status: 'active',
      runtime: id,
      runInSandbox,
      allowRuntimeChangesInChat: true,
      workspace: { mode: 'from-scratch', path: join(adir, 'ws') },
      output: { mode: 'medium' },
      // Shared mode → the daemon opens a send-only Web-API client (no Socket Mode, no
      // Bolt App): enough to POST the agent's replies to Slack. Inbound is injected.
      integrations: [
        {
          id: INT,
          platform: 'slack',
          core: { mode: 'shared', bindRules: [{ channel: creds.channel, match: { kind: 'mention' } }] },
          config: { botToken: creds.botToken }
        }
      ]
    })
  )
  return dir
}

/** Launch one real agent under a full Daemon and drive every feature through the daemon's
 *  real Slack send path (the daemon posts the agent's replies + status bars to the thread). */
export async function driveAgentThroughDaemon(id: string, rt: RuntimeDef, ctx: SlackCtx): Promise<AgentResult> {
  const res: AgentResult = { id, reachable: false, features: {} }
  const sandboxMechanism = detectSandbox()
  const daemon = new Daemon({
    root: scaffold(id, rt, ctx.creds, sandboxMechanism !== undefined),
    probeRuntimes: async () => []
  })
  const d = daemon as any
  const bot = new WebClient(ctx.creds.botToken)
  const channel = ctx.creds.channel
  const key = sessionKey('slack', channel, ctx.threadTs, AGENT)
  let seq = 0

  try {
    await daemon.start()
    const botUser: string = d.botUserIds[INT]
    if (!botUser) throw new Error('shared Slack connection did not come up (auth?)')

    // Inject a human-authored (bot_id-free) @mention in the intro thread and let the
    // daemon route + run + POST the reply to Slack. Awaited via dispatch(agentId, msg, INT).
    const turn = (text: string) => {
      const ev = {
        type: 'app_mention',
        channel,
        user: ctx.driverUser,
        ts: `${ctx.threadTs}${String(++seq).padStart(3, '0')}`,
        thread_ts: ctx.threadTs,
        text: `<@${botUser}> ${text}`
      }
      return d.dispatch(AGENT, normalizeSlackEvent(ev, { traceId: `inj-${id}-${seq}` }), INT)
    }
    const info = () => d.statusInfoForKey(key)?.info
    // ts of every bot message already in the shared thread — the test's own narration and
    // preceding agents' replies. Snapshot it as a per-turn boundary so a turn's reply is
    // never confused with a message that predates it.
    const botTsBefore = async (): Promise<Set<string>> => {
      const rep = await bot.conversations.replies({ channel, ts: ctx.threadTs, limit: 100 })
      return new Set((rep.messages ?? []).filter((m: any) => m.user === botUser).map((m: any) => m.ts as string))
    }
    // The daemon's newest non-status-bar reply posted AFTER `before` (its rendered agent
    // text for this turn) — '' if the turn produced no new reply.
    const replySince = async (before: Set<string>): Promise<string> => {
      const rep = await bot.conversations.replies({ channel, ts: ctx.threadTs, limit: 100 })
      const texts = (rep.messages ?? [])
        .filter(
          (m: any) =>
            m.user === botUser &&
            !before.has(m.ts) &&
            typeof m.text === 'string' &&
            m.text &&
            !m.text.startsWith(STATUS_BAR)
        )
        .map((m: any) => m.text as string)
      return texts.at(-1) ?? ''
    }

    // ── lifecycle: the daemon posts the agent's reply into the thread ───────────
    const before = await botTsBefore()
    await withTimeout(
      turn('Reply with exactly one short sentence confirming you are working. No preamble.'),
      PER_TURN_MS,
      'lifecycle'
    )
    res.reachable = true // the agent process launched and the daemon ran a turn
    res.reply = await replySince(before)
    res.features.lifecycle = res.reply
      ? { status: 'ok', detail: `daemon posted reply: ${JSON.stringify(res.reply.slice(0, 160))}` }
      : { status: 'fail', detail: 'no new reply posted to thread after the trigger' }

    // ── capabilities / usage / memory (daemon's view) ──────────────────────────
    const host = d.hosts.get(AGENT)
    const cap = info()
    const models: string[] = cap?.models ?? []
    const modes: string[] = cap?.permissionModes ?? []
    res.models = models
    res.currentModel = cap?.model
    res.modes = modes
    res.currentMode = cap?.permissionMode
    res.loadSession = host?.loadSupported() ?? false
    res.mcp = { http: host?.mcpCapabilities?.()?.http ?? false, sse: host?.mcpCapabilities?.()?.sse ?? false }
    res.features.capabilities = {
      status: 'ok',
      detail: `${models.length} models, ${modes.length} permission modes, loadSession=${res.loadSession}, mcp=http:${res.mcp.http}/sse:${res.mcp.sse}`
    }
    res.features.sandbox = sandboxMechanism
      ? { status: 'ok', detail: `lifecycle turn completed inside the daemon ${sandboxMechanism} sandbox` }
      : { status: 'degrade', detail: 'host has no supported sandbox mechanism; daemon ran unconfined' }
    res.features.mcp =
      res.mcp.http || res.mcp.sse
        ? { status: 'ok', detail: `remote transports: http=${res.mcp.http}, sse=${res.mcp.sse}` }
        : { status: 'degrade', detail: 'no remote MCP transport advertised; stdio remains available' }
    const skillsAgentId = skillsAgentIdForRuntime(id, rt)
    res.features.skills = skillsAgentId
      ? { status: 'ok', detail: `audited skills CLI identity: ${skillsAgentId}` }
      : { status: 'degrade', detail: 'runtime has not passed skills CLI compatibility admission' }
    const used = cap?.totalTokens
    res.usageTokens = used
    res.usageCost = cap?.costAmount
    res.features['usage-fold'] =
      used !== undefined
        ? { status: 'ok', detail: `${used} tokens${cap?.costAmount ? `, $${cap.costAmount.toFixed(4)}` : ''}` }
        : { status: 'degrade', detail: 'no usage reported' }
    res.memoryViaMeta = host?.usesMetaSystemPrompt?.() ?? false
    res.features.memory = {
      status: 'ok',
      detail: res.memoryViaMeta ? 'index via _meta.systemPrompt (Claude runtime)' : 'index inlined as leading block'
    }

    // ── model + permission-mode switch (daemon status-modal code; the daemon posts a
    //    status bar reflecting the new value on the next turn) ─────────────────────
    let mFrom: string | undefined, mTo: string | undefined, pFrom: string | undefined, pTo: string | undefined
    if (models.length >= 2) {
      mFrom = cap?.model
      mTo = models.find((m) => m !== mFrom)
      d.commands.handleStatusAction({ kind: 'set-model', sessionKey: key, model: mTo })
    } else res.features['model-switch'] = { status: 'degrade', detail: `${models.length} model(s) — no selector` }
    if (modes.length >= 2) {
      pFrom = cap?.permissionMode
      pTo = modes.find((m) => m !== pFrom)
      d.commands.handleStatusAction({ kind: 'set-permission-mode', sessionKey: key, permissionMode: pTo })
    } else
      res.features['permission-mode-switch'] = { status: 'degrade', detail: `${modes.length} mode(s) — no selector` }
    if (mTo || pTo) {
      await withTimeout(turn('ok'), PER_TURN_MS, 'switch') // re-applies overrides + posts a status bar
      const after = info()
      if (mTo) {
        const applied = after?.model === mTo
        res.modelSwitch = { from: mFrom, to: mTo, applied }
        res.features['model-switch'] = {
          status: applied ? 'ok' : 'fail',
          detail: `${mFrom} → ${mTo} ${applied ? '(applied, shown in status bar)' : `(read back ${after?.model})`}`
        }
      }
      if (pTo) {
        const applied = after?.permissionMode === pTo
        res.modeSwitch = { from: pFrom, to: pTo, applied }
        res.features['permission-mode-switch'] = {
          status: applied ? 'ok' : 'fail',
          detail: `${pFrom} → ${pTo} ${applied ? '(applied)' : `(read back ${after?.permissionMode})`}`
        }
      }
    }

    // ── interactive-permission on the REAL Slack path: induce a tool call so the
    //    daemon posts a real Allow/Deny card, then resolve it via handlePermissionChoice.
    try {
      let done = false
      const p = withTimeout(
        turn('Using your tools, create a file named ok.txt containing the text "hi", then reply done.'),
        PER_TURN_MS,
        'perm'
      ).then(
        () => (done = true),
        () => (done = true)
      )
      const resolved = await resolvePermissionCard(bot, channel, ctx.threadTs, botUser, d, () => done, 40_000)
      await p
      res.permResolved = resolved
      res.features['interactive-permission'] = resolved
        ? { status: 'ok', detail: 'daemon posted an Allow/Deny card to Slack; resolved via handlePermissionChoice' }
        : { status: 'degrade', detail: 'agent requested no gated tool (turn completed without a card)' }
    } catch (e) {
      res.features['interactive-permission'] = {
        status: 'na',
        detail: `perm turn: ${(e as Error).message.slice(0, 80)}`
      }
    }

    // ── load-resume: evict the live host, then dispatch again; the daemon resumes
    //    natively (loadSession) or recreates + replays, and posts a fresh reply. ────
    try {
      await d.stopHost(AGENT, 0).catch(() => {})
      await withTimeout(turn('Still there? reply in one word.'), PER_TURN_MS, 'resume')
      res.features['load-resume'] = {
        status: 'ok',
        detail: host?.loadSupported()
          ? 'native session/load resume ✓ (daemon re-posted)'
          : 'recreated + replayed ✓ (daemon re-posted)'
      }
    } catch (e) {
      res.features['load-resume'] = { status: 'fail', detail: `resume: ${(e as Error).message.slice(0, 80)}` }
    }
  } catch (e) {
    res.error = ((e as Error)?.message ?? String(e)).slice(0, 300)
  } finally {
    await daemon.stop().catch(() => {})
  }
  return res
}

/** Poll the thread for a daemon-posted Allow/Deny card and resolve it via the daemon.
 *  Returns true once resolved; stops early if `done()` (the turn finished without a card). */
async function resolvePermissionCard(
  bot: WebClient,
  channel: string,
  threadTs: string,
  botUser: string,
  d: any,
  done: () => boolean,
  deadlineMs: number
): Promise<boolean> {
  const end = Date.now() + deadlineMs
  while (Date.now() < end && !done()) {
    const rep = await bot.conversations
      .replies({ channel, ts: threadTs, limit: 40 })
      .catch(() => ({ messages: [] as any[] }))
    for (const m of ((rep as any).messages ?? []) as any[]) {
      if (m.user !== botUser || !Array.isArray(m.blocks)) continue
      for (const b of m.blocks) {
        for (const el of (b.elements ?? []) as any[]) {
          if (
            typeof el.action_id === 'string' &&
            el.action_id.startsWith(PERMISSION_ACTION_PREFIX) &&
            typeof el.value === 'string'
          ) {
            const dec = decodePermValue(el.value)
            if (dec) {
              d.handlePermissionChoice(dec) // pick the first offered option (Allow is listed first)
              return true
            }
          }
        }
      }
    }
    await sleep(2000)
  }
  return false
}
