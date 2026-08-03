/**
 * Game subjects — who plays (docs/designs/collaboration-arena.md §8.1/§14).
 *
 * `scripted` is the reproducible engine gate: deterministic in-process ACP
 * hosts, no credentials. `real` runs the IDENTICAL game against the operator's
 * subject template (real runtimes, real provider credentials): each compiled
 * game agent is materialized from a template agent with the compiled UUID
 * identity, memory off, and NO on-disk integrations — the evaluation
 * environment (§5) stays the only integration authority. Any difference
 * between the two is behavioral, not engine uncertainty.
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { collectObjectSecrets, environmentSecrets } from '../../packages/daemon/src/evaluation/index.js'
import type { CompiledTopology } from './types.js'

export type GameSubjectSpec =
  | { kind: 'scripted' }
  | {
      kind: 'real'
      /** Template root: config.json (with explicit runtimes) + agents/<id>/agent.json. */
      subjectRoot: string
      /** Template agent ids mapped onto the game's agent aliases IN ORDER.
       *  One id may be repeated to clone a single template into every seat;
       *  a single-element list is broadcast. */
      templateAgentIds: string[]
    }

export interface PreparedGameSubject {
  root: string
  /** Values that must never reach an artifact: template credentials plus
   *  secret-shaped process environment values. The runner feeds these into
   *  every collector/writer redaction set. */
  secrets: string[]
  cleanup(): void
}

function assertNotSymlink(path: string, label: string): void {
  if (lstatSync(path).isSymbolicLink()) throw new Error(`${label} may not be a symbolic link`)
}

function assertNoSymlinks(path: string, label: string): void {
  assertNotSymlink(path, label)
  if (!lstatSync(path).isDirectory()) return
  for (const entry of readdirSync(path)) assertNoSymlinks(join(path, entry), label)
}

/** Disposable scripted subject: one scripted-runtime agent per compiled agent id.
 *  Integrations stay EMPTY on disk — the evaluation environment (§5) is the only
 *  authority that projects the virtual integrations in. */
export function prepareScriptedSubject(topology: CompiledTopology): PreparedGameSubject {
  const root = mkdtempSync(join(tmpdir(), 'ac-arena-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { scripted: { command: 'node', args: ['unused'] } }
    })
  )
  for (const agent of topology.agents) {
    const agentDir = join(root, 'agents', agent.agentId)
    mkdirSync(agentDir, { recursive: true, mode: 0o700 })
    mkdirSync(join(agentDir, 'workspace'), { recursive: true, mode: 0o700 })
    writeFileSync(
      join(agentDir, 'agent.json'),
      JSON.stringify(
        {
          id: agent.agentId,
          name: agent.alias,
          status: 'active',
          runtime: 'scripted',
          workspace: { mode: 'from-scratch', path: join(agentDir, 'workspace') },
          integrations: [],
          output: { mode: 'low', showFooter: false, showStatusBar: false }
        },
        null,
        2
      )
    )
  }
  return { root, secrets: [], cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/**
 * Disposable REAL subject: the template's config (explicit runtime definitions,
 * provider credentials via runtime env) with each game seat materialized from a
 * template agent under the compiled UUID id. Control plane, relays, crons, MCP
 * servers, and platform integrations are stripped; account-app isolation is
 * FORCED on (the evaluation environment must stay the only integration
 * authority, so a subject may not inherit account-attached apps/connectors);
 * memory is off (game runs measure coordination, not recall); the workspace is
 * from-scratch. Every secret-shaped template value is harvested for redaction.
 */
export function prepareRealSubject(
  topology: CompiledTopology,
  spec: Extract<GameSubjectSpec, { kind: 'real' }>
): PreparedGameSubject {
  const sourceRoot = resolve(spec.subjectRoot)
  const configPath = join(sourceRoot, 'config.json')
  if (!existsSync(configPath)) throw new Error(`game subject template is missing ${configPath}`)
  if (spec.templateAgentIds.length === 0) throw new Error('real game subject requires at least one templateAgentId')
  const root = mkdtempSync(join(tmpdir(), 'ac-arena-real-'))
  const cleanup = () => rmSync(root, { recursive: true, force: true })
  try {
    assertNoSymlinks(configPath, 'game subject config')
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
    const secrets = collectObjectSecrets(config)
    const runtimes =
      config.runtimes && typeof config.runtimes === 'object' && !Array.isArray(config.runtimes)
        ? (config.runtimes as Record<string, unknown>)
        : {}
    const templateSecurity =
      config.security && typeof config.security === 'object' && !Array.isArray(config.security)
        ? (config.security as Record<string, unknown>)
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
          // Preserve the operator's security posture EXCEPT account-app reach:
          // a subject must not inherit account-attached apps/connectors.
          security: { ...templateSecurity, isolateAccountApps: true }
        },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    )
    const sourceAgentsDir = join(sourceRoot, 'agents')
    assertNotSymlink(sourceAgentsDir, 'game subject agents directory')
    for (const [index, agent] of topology.agents.entries()) {
      const templateId = spec.templateAgentIds[index % spec.templateAgentIds.length]!
      if (templateId === '.' || templateId === '..' || /[/\\\0]/.test(templateId)) {
        throw new Error(`game subject template agent id is not a safe path segment: ${JSON.stringify(templateId)}`)
      }
      const sourceAgentDir = join(sourceAgentsDir, templateId)
      const sourceAgentPath = join(sourceAgentDir, 'agent.json')
      if (!existsSync(sourceAgentPath)) throw new Error(`game subject template has no agent "${templateId}"`)
      assertNotSymlink(sourceAgentDir, `game subject agent "${templateId}" directory`)
      assertNoSymlinks(sourceAgentPath, `game subject agent "${templateId}" config`)
      const template = JSON.parse(readFileSync(sourceAgentPath, 'utf8')) as Record<string, unknown>
      collectObjectSecrets(template, '', secrets)
      if (typeof template.runtime !== 'string' || !Object.prototype.hasOwnProperty.call(runtimes, template.runtime)) {
        throw new Error(`game subject agent "${templateId}" requires an explicit runtime definition in config.json`)
      }
      const targetAgentDir = join(root, 'agents', agent.agentId)
      mkdirSync(targetAgentDir, { recursive: true, mode: 0o700 })
      const workspacePath = join(targetAgentDir, 'workspace')
      mkdirSync(workspacePath, { recursive: true, mode: 0o700 })
      const sourceInstructions = join(sourceAgentDir, 'instructions.md')
      if (existsSync(sourceInstructions)) {
        assertNoSymlinks(sourceInstructions, `game subject agent "${templateId}" instructions`)
        cpSync(sourceInstructions, join(targetAgentDir, 'instructions.md'), { dereference: false })
      }
      const prepared = {
        ...template,
        id: agent.agentId,
        name: agent.alias,
        displayName: agent.alias,
        status: 'active',
        pause: false,
        integrations: [],
        crons: [],
        mcpServers: [],
        memory: { provider: 'none' },
        workspace: { mode: 'from-scratch', path: workspacePath, gitBranch: 'main', pullOnNewSession: true, skills: [] },
        output: { mode: 'low', showFooter: false, showStatusBar: false }
      }
      writeFileSync(join(targetAgentDir, 'agent.json'), `${JSON.stringify(prepared, null, 2)}\n`, { mode: 0o600 })
    }
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

export function prepareGameSubject(topology: CompiledTopology, spec: GameSubjectSpec): PreparedGameSubject {
  return spec.kind === 'scripted' ? prepareScriptedSubject(topology) : prepareRealSubject(topology, spec)
}
