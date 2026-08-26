/**
 * LOCAL-ONLY live runtime support matrix.
 *
 * This suite discovers the runtimes installed on this machine, starts their real
 * ACP adapters, and sends real prompts to their configured model providers. It is
 * intentionally skipped in CI: results are facts about this host's installation,
 * authentication, sandbox, and provider access, not deterministic unit contracts.
 *
 * Run explicitly with:
 *   pnpm --filter @agentconnect.md/daemon test:runtime-matrix
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { McpServer } from '@agentclientprotocol/sdk'
import { AcpHost, turnFailureCode, turnFailureReason } from '../../src/acp/acp-host.js'
import { detectSandbox } from '../../src/acp/sandbox.js'
import { loadConfig } from '../../src/config/load-config.js'
import type { RuntimeDef } from '../../src/config/config-schema.js'
import { resolveRoot } from '../../src/paths.js'
import { installSkills } from '../../src/skills/install-skills.js'
import { composeRuntimeLaunch } from '../../src/launch/compose.js'
import { installedRuntimeCatalog } from '../../src/runtimes/probe.js'
import { resolveRuntimeCatalog, type ResolvedRuntimeEntry } from '../../src/runtimes/registry.js'
import { FEATURES, type FeatureId } from './support-matrix.js'

const IS_CI = Boolean(process.env.CI || process.env.GITHUB_ACTIONS)
const TURN_TIMEOUT = 180_000
const SUITE_TIMEOUT = 30 * 60_000
const SKILL_NAME = 'runtime-matrix-probe'
const DEBUG_CHILD = process.env.AC_RUNTIME_MATRIX_DEBUG === '1'

type Status = 'ok' | 'degrade' | 'na' | 'unavailable' | 'fail'
interface Outcome {
  status: Status
  detail: string
}
interface RuntimeResult {
  id: string
  reachable: boolean
  features: Partial<Record<FeatureId, Outcome>>
  error?: string
  cleanupError?: string
  models: string[]
  modes: string[]
  mcp: { http: boolean; sse: boolean }
}

interface RuntimeTarget {
  id: string
  runtime: RuntimeDef
  entry: ResolvedRuntimeEntry
}

interface ProbeEndpoint {
  server: Server
  url: string
  calls: () => number
}

function withTimeout<T>(promise: Promise<T>, label: string, timeout = TURN_TIMEOUT): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeout}ms`)), timeout)
      timer.unref?.()
    })
  ])
}

function textChunks(updates: unknown[], from = 0): string[] {
  return updates
    .slice(from)
    .filter(
      (update: any) =>
        update?.sessionUpdate === 'agent_message_chunk' &&
        update?.content?.type === 'text' &&
        typeof update.content.text === 'string'
    )
    .map((update: any) => update.content.text as string)
}

function mcpProbeEndpoint(): Promise<ProbeEndpoint> {
  let toolCalls = 0
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')))
    req.on('end', () => {
      let rpc: { id?: string | number; method?: string } = {}
      try {
        rpc = JSON.parse(body) as typeof rpc
      } catch {
        // A malformed request is still a real compatibility failure: answer 400.
        res.writeHead(400).end()
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      if (rpc.id === undefined) {
        res.writeHead(202).end()
        return
      }
      if (rpc.method === 'tools/call') {
        toolCalls += 1
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: { content: [{ type: 'text', text: 'MATRIX_MCP_OK' }], isError: false }
          })
        )
        return
      }
      const result =
        rpc.method === 'initialize'
          ? {
              protocolVersion: '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'agentconnect-runtime-matrix', version: '1' }
            }
          : rpc.method === 'tools/list'
            ? {
                tools: [
                  {
                    name: 'runtime_matrix_probe',
                    description: 'Returns MATRIX_MCP_OK. Use only for the AgentConnect runtime matrix.',
                    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
                  }
                ]
              }
            : {}
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ server, url: `http://127.0.0.1:${port}/mcp`, calls: () => toolCalls })
    })
  })
}

function selectAllowOption(params: any): { outcome: { outcome: 'selected'; optionId: string } } | undefined {
  const options = Array.isArray(params?.options) ? params.options : []
  const selected = options.find((option: any) => String(option?.kind ?? '').startsWith('allow')) ?? options[0]
  return selected?.optionId ? { outcome: { outcome: 'selected', optionId: String(selected.optionId) } } : undefined
}

function providerUnavailable(error: unknown): boolean {
  if (turnFailureCode(error) !== 'turn_failed') return true
  const message = turnFailureReason(error).toLowerCase()
  return [
    'authentication required',
    'authenticate first',
    'credit usage limit',
    'weekly limit',
    'usage limit',
    'quota',
    'high demand',
    'rate limit'
  ].some((part) => message.includes(part))
}

function runtimeErrorOutcome(error: unknown): Outcome {
  return {
    status: providerUnavailable(error) ? 'unavailable' : 'fail',
    detail: turnFailureReason(error)
  }
}

async function installProbeSkill(
  target: RuntimeTarget,
  root: string,
  agentDir: string,
  cwd: string,
  token: string
): Promise<Outcome> {
  if (!target.entry.skillsAgentId) {
    return { status: 'degrade', detail: 'runtime has no audited skills CLI identity' }
  }
  const sourceDir = join(root, 'skill-source')
  mkdirSync(sourceDir, { recursive: true })
  writeFileSync(
    join(sourceDir, 'SKILL.md'),
    `---\nname: ${SKILL_NAME}\ndescription: Use only when the user says ACTIVATE_SKILL_PROBE.\n---\n\n# Runtime matrix probe\n\nWhen invoked, reply with exactly: ${token}\n`
  )
  const result = await installSkills({ id: 'runtime-matrix', runtime: target.id, skills: [], dir: agentDir }, cwd, {
    stateDir: join(root, 'skill-state'),
    skillsAgentId: target.entry.skillsAgentId,
    localSkills: [{ kind: 'managed', key: `matrix:${target.id}`, name: SKILL_NAME, sourceDir }]
  })
  if (result.errors.length > 0 || result.installed.length === 0) {
    return { status: 'fail', detail: result.errors.map((error) => error.error).join('; ') || 'skill was not installed' }
  }
  return { status: 'ok', detail: `installed via skills CLI identity ${target.entry.skillsAgentId}` }
}

async function runSandboxProbe(target: RuntimeTarget, root: string, token: string): Promise<Outcome> {
  const mechanism = detectSandbox()
  if (!mechanism) return { status: 'degrade', detail: 'no supported sandbox mechanism on this host' }

  const scopeDir = join(root, 'sandbox-agent')
  const sandboxCwd = join(scopeDir, 'workspace')
  mkdirSync(sandboxCwd, { recursive: true })
  const composed = composeRuntimeLaunch({
    runtimeId: target.id,
    runtime: target.runtime,
    provider: 'managed',
    scopeDir,
    cwd: sandboxCwd,
    runInSandbox: true,
    daemonRoot: root,
    sandboxMechanism: mechanism,
    hostEnv: process.env,
    stateSourceEnv: process.env
  })
  const updates: unknown[] = []
  const host = new AcpHost(composed.runtime, {
    runtimeId: target.id,
    suppressChildStderr: !DEBUG_CHILD,
    onUpdate: (_sessionId, update) => updates.push(update),
    env: composed.launch.env,
    inheritProcessEnv: composed.launch.inheritProcessEnv,
    sandbox: composed.launch.sandbox
  })
  let sessionId: string | undefined
  try {
    await withTimeout(host.start(), `${target.id}/sandbox start`)
    sessionId = await withTimeout(host.newSession(sandboxCwd), `${target.id}/sandbox session`)
    await withTimeout(
      host.prompt(sessionId, [{ type: 'text', text: `Reply with exactly ${token} and nothing else.` }]),
      `${target.id}/sandbox prompt`
    )
    const output = textChunks(updates).join('')
    return output.includes(token)
      ? { status: 'ok', detail: `real model turn completed inside ${mechanism}` }
      : { status: 'fail', detail: `sandboxed model reply did not contain ${token}` }
  } finally {
    try {
      if (sessionId && host.deleteSupported())
        await withTimeout(host.deleteSession(sessionId), `${target.id}/sandbox session delete`)
    } finally {
      await host.stop().catch(() => {})
    }
  }
}

async function runRuntime(target: RuntimeTarget): Promise<RuntimeResult> {
  const result: RuntimeResult = {
    id: target.id,
    reachable: false,
    features: {},
    models: [],
    modes: [],
    mcp: { http: false, sse: false }
  }
  const root = mkdtempSync(join(tmpdir(), `ac-runtime-matrix-${target.id.replace(/[^a-z0-9-]/gi, '-')}-`))
  const agentDir = join(root, 'agent')
  const cwd = join(agentDir, 'workspace')
  mkdirSync(cwd, { recursive: true })
  const nonce = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const memoryToken = `MATRIX_MEMORY_OK_${nonce}`
  const skillToken = `MATRIX_SKILL_OK_${nonce}`
  const sandboxToken = `MATRIX_SANDBOX_OK_${nonce}`
  const updates: unknown[] = []
  let permissionRequested = false
  let host: AcpHost | undefined
  let endpoint: ProbeEndpoint | undefined
  const sessionIds = new Set<string>()
  const rememberSession = (sessionId: string): string => {
    sessionIds.add(sessionId)
    return sessionId
  }

  try {
    const skillInstall = await installProbeSkill(target, root, agentDir, cwd, skillToken).catch((error): Outcome => ({
      status: 'fail',
      detail: `skills install: ${(error as Error).message}`
    }))

    host = new AcpHost(target.runtime, {
      runtimeId: target.id,
      suppressChildStderr: true,
      onUpdate: (_sessionId, update) => updates.push(update),
      onPermission: async (_sessionId, params) => {
        permissionRequested = true
        return selectAllowOption(params)
      }
    })
    await withTimeout(host.start(), `${target.id}/start`)
    result.reachable = true
    result.mcp = host.mcpCapabilities() ?? { http: false, sse: false }

    const usesMeta = host.usesMetaSystemPrompt()
    const sessionId = rememberSession(
      await withTimeout(host.newSession(cwd, [], undefined, usesMeta ? memoryToken : undefined), `${target.id}/session`)
    )
    result.models = host.modelOptions()?.models ?? []
    result.modes = host.permissionModeOptions()?.modes ?? []
    result.features.capabilities = {
      status: 'ok',
      detail: `${result.models.length} models, ${result.modes.length} modes, load=${host.loadSupported()}, mcp=http:${result.mcp.http}/sse:${result.mcp.sse}`
    }
    const lifecycleStart = updates.length
    const lifecyclePrompt = usesMeta
      ? `The standing context contains a token beginning MATRIX_MEMORY_OK_. Reply with that exact token only.`
      : `# Memory\n${memoryToken}\n\nReply with the exact memory token above and nothing else.`
    const lifecycle = await withTimeout(
      host.prompt(sessionId, [{ type: 'text', text: lifecyclePrompt }]),
      `${target.id}/lifecycle`
    )
    const lifecycleText = textChunks(updates, lifecycleStart).join('')
    result.features.lifecycle = lifecycleText.trim()
      ? { status: 'ok', detail: `real provider replied (${lifecycle.stopReason})` }
      : { status: 'fail', detail: 'real provider returned no agent message' }
    result.features.memory = lifecycleText.includes(memoryToken)
      ? { status: 'ok', detail: `real model recalled session-start index via ${usesMeta ? '_meta' : 'inline block'}` }
      : { status: 'fail', detail: `real model reply did not contain ${memoryToken}` }
    result.features['usage-fold'] = lifecycle.usage
      ? { status: 'ok', detail: `${lifecycle.usage.totalTokens} tokens` }
      : { status: 'degrade', detail: 'runtime returned no ACP usage object' }

    if (result.models.length >= 2) {
      const from = host.modelOptions()?.current
      const to = result.models.find((model) => model !== from)!
      const sent = await host.setSessionModel(sessionId, to)
      const current = host.modelOptions()?.current
      result.features['model-switch'] =
        sent && current === to
          ? { status: 'ok', detail: `${from ?? '?'} -> ${to}` }
          : { status: 'fail', detail: `requested ${to}; rpcSent=${sent}, current=${current ?? '?'}` }
    } else {
      result.features['model-switch'] = { status: 'degrade', detail: `${result.models.length} model(s)` }
    }

    if (result.modes.length >= 2) {
      const from = host.permissionModeOptions()?.current
      const to = result.modes.find((mode) => mode !== from)!
      const sent = await host.setSessionPermissionMode(sessionId, to)
      const current = host.permissionModeOptions()?.current
      result.features['permission-mode-switch'] =
        sent && current === to
          ? { status: 'ok', detail: `${from ?? '?'} -> ${to}` }
          : { status: 'fail', detail: `requested ${to}; rpcSent=${sent}, current=${current ?? '?'}` }
    } else {
      result.features['permission-mode-switch'] = { status: 'degrade', detail: `${result.modes.length} mode(s)` }
    }

    if (result.mcp.http) {
      endpoint = await mcpProbeEndpoint()
      const descriptor: McpServer = {
        type: 'http',
        name: 'runtime-matrix',
        url: endpoint.url,
        headers: []
      }
      const mcpSession = rememberSession(
        await withTimeout(host.newSession(cwd, [descriptor]), `${target.id}/mcp session`)
      )
      const mcpStart = updates.length
      await withTimeout(
        host.prompt(mcpSession, [
          {
            type: 'text',
            text: 'Call the MCP tool runtime_matrix_probe now. Reply with exactly the text returned by the tool.'
          }
        ]),
        `${target.id}/mcp prompt`
      )
      const mcpText = textChunks(updates, mcpStart).join('')
      result.features.mcp =
        endpoint.calls() > 0 && mcpText.includes('MATRIX_MCP_OK')
          ? { status: 'ok', detail: `${endpoint.calls()} real HTTP MCP tools/call request(s)` }
          : { status: 'fail', detail: `toolCalls=${endpoint.calls()}, reply=${JSON.stringify(mcpText.slice(0, 120))}` }
    } else {
      result.features.mcp = {
        status: 'degrade',
        detail: result.mcp.sse ? 'SSE advertised; HTTP live probe unavailable' : 'HTTP/SSE not advertised'
      }
    }

    if (skillInstall.status === 'ok') {
      const skillStart = updates.length
      await withTimeout(
        host.prompt(sessionId, [
          {
            type: 'text',
            text: `ACTIVATE_SKILL_PROBE. Use the ${SKILL_NAME} skill now and follow its instructions exactly.`
          }
        ]),
        `${target.id}/skills prompt`
      )
      const skillText = textChunks(updates, skillStart).join('')
      result.features.skills = skillText.includes(skillToken)
        ? { status: 'ok', detail: `${skillInstall.detail}; real model discovered and followed it` }
        : {
            status: 'fail',
            detail: `installed skill was not followed; reply=${JSON.stringify(skillText.slice(0, 120))}`
          }
    } else {
      result.features.skills = skillInstall
    }

    // Keep this independent of the permission-mode switch above: modes such as
    // read-only, plan, or full-access can suppress the permission request itself.
    const permissionSession = rememberSession(
      await withTimeout(host.newSession(cwd), `${target.id}/permission session`)
    )
    permissionRequested = false
    const permissionStart = updates.length
    await withTimeout(
      host.prompt(permissionSession, [
        {
          type: 'text',
          text: 'Using your file tool, create matrix-permission.txt in the current workspace containing OK, then reply done.'
        }
      ]),
      `${target.id}/permission prompt`
    )
    result.features['interactive-permission'] = permissionRequested
      ? { status: 'ok', detail: 'real runtime requested permission and received an allow decision' }
      : {
          status: 'degrade',
          detail: `runtime completed without an ACP permission request (${textChunks(updates, permissionStart).join('').slice(0, 80)})`
        }

    // Run this independently before the resume/restart phase so a runtime-specific
    // session/load failure cannot masquerade as a sandbox failure.
    result.features.sandbox = await runSandboxProbe(target, root, sandboxToken).catch(runtimeErrorOutcome)

    if (host.loadSupported()) {
      await host.stop()
      host = new AcpHost(target.runtime, {
        runtimeId: target.id,
        suppressChildStderr: true,
        onUpdate: (_sessionId, update) => updates.push(update)
      })
      await withTimeout(host.start(), `${target.id}/resume start`)
      await withTimeout(host.loadSession(sessionId, cwd), `${target.id}/session load`)
      const resumeToken = `MATRIX_RESUME_OK_${nonce}`
      const resumeStart = updates.length
      await withTimeout(
        host.prompt(sessionId, [{ type: 'text', text: `Reply with exactly ${resumeToken}.` }]),
        `${target.id}/resume prompt`
      )
      result.features['load-resume'] = textChunks(updates, resumeStart).join('').includes(resumeToken)
        ? { status: 'ok', detail: 'real adapter restarted, loaded session, and completed a provider turn' }
        : { status: 'fail', detail: 'loaded session produced no matching provider reply' }
    } else {
      result.features['load-resume'] = { status: 'degrade', detail: 'runtime does not advertise session/load' }
    }
  } catch (error) {
    result.error = turnFailureReason(error)
    const status: Status = providerUnavailable(error) ? 'unavailable' : 'fail'
    for (const feature of FEATURES) {
      result.features[feature] ??= { status, detail: result.error }
    }
  } finally {
    try {
      if (host?.deleteSupported()) {
        const failures: unknown[] = []
        for (const sessionId of sessionIds) {
          try {
            await withTimeout(host.deleteSession(sessionId), `${target.id}/session delete`)
          } catch (error) {
            failures.push(error)
          }
        }
        if (failures.length > 0) {
          const cleanupError = `session cleanup: ${failures.map(turnFailureReason).join('; ')}`
          result.cleanupError = cleanupError
          result.error = result.error ? `${result.error}; ${cleanupError}` : cleanupError
        }
      }
    } finally {
      endpoint?.server.close()
      await host?.stop().catch(() => {})
      rmSync(root, { recursive: true, force: true })
    }
  }
  return result
}

const SHORT: Record<FeatureId, string> = {
  capabilities: 'caps',
  lifecycle: 'life',
  'model-switch': 'model',
  'permission-mode-switch': 'pmode',
  'load-resume': 'load',
  'interactive-permission': 'perm',
  'usage-fold': 'usage',
  memory: 'memory',
  sandbox: 'sbox',
  mcp: 'mcp',
  skills: 'skills'
}
const CELL: Record<Status, string> = { ok: '✓', degrade: '·', na: '~', unavailable: 'U', fail: '✗' }

function grid(results: RuntimeResult[], features: FeatureId[] = FEATURES): string {
  const idWidth = Math.max(7, ...results.map((result) => result.id.length))
  const widths = features.map((feature) => Math.max(3, SHORT[feature].length))
  const head = 'runtime'.padEnd(idWidth) + ' | ' + features.map((f, i) => SHORT[f].padStart(widths[i]!)).join(' ')
  const separator = '-'.repeat(idWidth) + '-+-' + widths.map((width) => '-'.repeat(width)).join('-')
  const rows = results.map(
    (result) =>
      result.id.padEnd(idWidth) +
      ' | ' +
      features
        .map((feature, index) => CELL[result.features[feature]?.status ?? 'na'].padStart(widths[index]!))
        .join(' ')
  )
  return [head, separator, ...rows, '', 'legend: ✓ real pass · degrade ~ n/a U provider unavailable ✗ fail'].join('\n')
}

describe.skipIf(IS_CI)('local live ACP runtime support matrix', () => {
  let targets: RuntimeTarget[] = []
  let features: FeatureId[] = FEATURES

  beforeAll(async () => {
    const daemonRoot = resolveRoot()
    const config = loadConfig({ root: daemonRoot, optional: true })
    const catalog = await resolveRuntimeCatalog(config, daemonRoot, { mode: 'cache-first' })
    const installed = installedRuntimeCatalog(catalog)
    const requested = new Set(
      (process.env.AC_RUNTIME_MATRIX_TARGETS ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
    )
    targets = Object.entries(installed.entries)
      .filter(([id]) => id !== 'qoder-cli-cn' && (requested.size === 0 || requested.has(id)))
      .map(([id, entry]) => ({ id, runtime: entry.runtime, entry }))
      .sort((a, b) => a.id.localeCompare(b.id))
    if (process.env.AC_RUNTIME_MATRIX_ONLY === 'sandbox') features = ['sandbox']
  })

  it(
    'starts every installed runtime and exercises its real model/provider',
    async () => {
      expect(targets.length, 'no installed ACP runtimes were discovered on this host').toBeGreaterThan(0)
      const results: RuntimeResult[] = []
      for (const target of targets) {
        const result =
          features.length === 1 && features[0] === 'sandbox'
            ? await (async (): Promise<RuntimeResult> => {
                const root = mkdtempSync(join(tmpdir(), `ac-runtime-matrix-sandbox-${target.id}-`))
                try {
                  const outcome = await runSandboxProbe(
                    target,
                    root,
                    `MATRIX_SANDBOX_OK_${Date.now().toString(36)}`
                  ).catch(runtimeErrorOutcome)
                  return {
                    id: target.id,
                    reachable: true,
                    features: { sandbox: outcome },
                    models: [],
                    modes: [],
                    mcp: { http: false, sse: false }
                  }
                } finally {
                  rmSync(root, { recursive: true, force: true })
                }
              })()
            : await runRuntime(target)
        results.push(result)
        console.info(
          `[runtime-matrix] ${target.id}: ${result.reachable ? 'reachable' : 'unavailable'}${result.error ? ` — ${result.error}` : ''}`
        )
      }

      console.info(`\nREAL local runtime matrix (${results.length} installed):\n${grid(results, features)}\n`)
      for (const result of results) {
        for (const feature of features) {
          const outcome = result.features[feature]
          if (outcome?.status === 'fail')
            console.info(`[runtime-matrix] FAIL ${result.id}/${feature}: ${outcome.detail}`)
        }
      }

      const failures = results.flatMap((result) => [
        ...features
          .filter((feature) => result.features[feature]?.status === 'fail')
          .map((feature) => `${result.id}/${feature}: ${result.features[feature]!.detail}`),
        ...(result.cleanupError ? [`${result.id}/cleanup: ${result.cleanupError}`] : [])
      ])
      if (features.includes('lifecycle')) {
        expect(
          results.some((result) => result.features.lifecycle?.status === 'ok'),
          'no installed runtime completed a real model/provider turn'
        ).toBe(true)
      }
      expect(failures, `real runtime failures:\n${failures.join('\n')}`).toEqual([])
    },
    SUITE_TIMEOUT
  )
})
