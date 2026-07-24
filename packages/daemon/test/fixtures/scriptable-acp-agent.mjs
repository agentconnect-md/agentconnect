#!/usr/bin/env node
// Scenario-driven ACP agent for the daemon↔ACP integration matrix.
//
// One binary emulates the OBSERVABLE ACP behavior of every runtime the daemon
// targets (claude-acp / codex-acp / pi-acp / cursor / opencode / cline / devin /
// grok-build). The concrete personality is a JSON scenario whose path is passed in
// `AC_SCENARIO`; see test/acp-matrix/profiles.ts for the shapes. Keeping the agent
// side declarative means the DAEMON's AcpHost is the only thing under test.
//
// It is a hand-rolled JSON-RPC 2.0 peer over newline-delimited JSON on stdio (like
// fake-acp-agent.mjs) — but it BOTH answers agent methods AND initiates client
// requests (session/request_permission, elicitation/create) so the daemon's
// permission/elicitation fallbacks are exercised end-to-end.
import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'

const scenario = process.env.AC_SCENARIO ? JSON.parse(readFileSync(process.env.AC_SCENARIO, 'utf8')) : {}

const rl = createInterface({ input: process.stdin })
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')

// `ignoreSigterm` simulates a hung/buggy adapter for AcpHost.stop() escalation: the
// graceful stdin-EOF + SIGTERM are swallowed and a keep-alive interval survives, so
// only the SIGKILL fallback can reap it.
if (scenario.ignoreSigterm) {
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1000)
}

// Client requests WE initiate (permission/elicitation) — track their responses so a
// prompt can await the daemon's decision before continuing the turn.
let rpcId = 1_000_000
const pending = new Map()
function clientRequest(method, params) {
  const id = ++rpcId
  return new Promise((resolve) => {
    pending.set(id, resolve)
    send({ jsonrpc: '2.0', id, method, params })
  })
}

// Per-session live config-option set (deep-cloned from the scenario so a
// set_config_option mutates only this session's currentValue).
const sessionOptions = new Map()
// Per-session `_meta` captured at session/new|load — lets the memory feature assert
// the daemon routed the memory index via `_meta.systemPrompt` (Claude) rather than a
// user turn.
const sessionMeta = new Map()
let sessionCounter = 0

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))

const update = (sessionId, u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } })
const textChunk = (text) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })

/** Substitute the `$INPUT` marker in a scripted text update with the real prompt text. */
function materialize(u, input) {
  if (u?.content?.type === 'text' && u.content.text === '$INPUT') {
    return { ...u, content: { ...u.content, text: `echo:${input}` } }
  }
  return u
}

async function handlePrompt(id, params) {
  const p = scenario.prompt ?? {}
  const input = (params.prompt ?? []).map((b) => b.text ?? '').join('')

  // Optional interactive round-trips BEFORE the reply — the daemon resolves these via
  // its onPermission/onElicit policy or the auto-allow / decline fallbacks. We echo the
  // daemon's decision back as a chunk so tests can assert exactly what it chose.
  if (p.requestPermission) {
    const res = await clientRequest('session/request_permission', {
      sessionId: params.sessionId,
      toolCall: p.requestPermission.toolCall ?? { toolCallId: 'tc1', title: 'run', kind: 'execute' },
      options: p.requestPermission.options
    })
    update(params.sessionId, textChunk(`perm:${JSON.stringify(res.result?.outcome ?? res.error ?? null)}`))
  }
  if (p.elicit) {
    const res = await clientRequest('elicitation/create', { sessionId: params.sessionId, ...p.elicit })
    update(params.sessionId, textChunk(`elicit:${JSON.stringify(res.result ?? res.error ?? null)}`))
  }

  // Memory routing probe: echo the `_meta.systemPrompt.append` the daemon sent at
  // session/new (null when it used no `_meta` channel — i.e. non-Claude runtimes).
  if (p.echoSysMeta) {
    const append = sessionMeta.get(params.sessionId)?.systemPrompt?.append ?? null
    update(params.sessionId, textChunk(`sysmeta:${JSON.stringify(append)}`))
  }

  // Scripted stream. Default = a single echo chunk (keeps simple profiles terse).
  const updates = p.updates ?? [textChunk(`echo:${input}`)]
  for (const u of updates) update(params.sessionId, materialize(u, input))

  if (p.error) {
    send({ jsonrpc: '2.0', id, error: { code: p.error.code ?? -32000, message: p.error.message ?? 'error' } })
    return
  }
  send({
    jsonrpc: '2.0',
    id,
    result: { stopReason: p.stopReason ?? 'end_turn', ...(p.usage ? { usage: p.usage } : {}) }
  })
}

rl.on('line', async (line) => {
  if (!line.trim()) return
  const msg = JSON.parse(line)

  // A response to one of OUR client requests (has id, no method).
  if (msg.method === undefined && msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const resolve = pending.get(msg.id)
    if (resolve) {
      pending.delete(msg.id)
      resolve(msg)
    }
    return
  }

  const { id, method, params } = msg
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: { protocolVersion: 1, agentCapabilities: scenario.agentCapabilities ?? {} }
    })
  } else if (method === 'session/new') {
    const sessionId = `s${++sessionCounter}`
    sessionOptions.set(sessionId, clone(scenario.configOptions))
    sessionMeta.set(sessionId, params._meta)
    send({ jsonrpc: '2.0', id, result: { sessionId, configOptions: sessionOptions.get(sessionId) } })
  } else if (method === 'session/load') {
    if (!scenario.agentCapabilities?.loadSession) {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'session/load not supported' } })
      return
    }
    // Replay history (must be suppressed by the daemon) + a restored-title metadata
    // update (must be forwarded).
    for (const u of scenario.load?.replay ?? [textChunk('historical output')]) update(params.sessionId, u)
    update(params.sessionId, { sessionUpdate: 'session_info_update', title: scenario.load?.title ?? 'Restored title' })
    sessionOptions.set(params.sessionId, clone(scenario.configOptions))
    sessionMeta.set(params.sessionId, params._meta)
    send({ jsonrpc: '2.0', id, result: { configOptions: sessionOptions.get(params.sessionId) } })
  } else if (method === 'session/set_config_option') {
    const opts = sessionOptions.get(params.sessionId) ?? clone(scenario.configOptions) ?? []
    const opt = opts.find((o) => o.id === params.configId)
    if (opt) opt.currentValue = params.value
    sessionOptions.set(params.sessionId, opts)
    send({ jsonrpc: '2.0', id, result: { configOptions: opts } })
  } else if (method === 'session/prompt') {
    await handlePrompt(id, params)
  } else if (method === 'session/cancel') {
    // Notification (no id) — nothing to answer.
    if (id !== undefined) send({ jsonrpc: '2.0', id, result: null })
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, result: null })
  }
})
