import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CpAgentRegistry } from '../../src/cp/cp-agent-registry.js'
import type { AgentSpec } from '@agentconnect.md/protocol'

const A1 = '11111111-1111-4111-8111-111111111111'
const A2 = '22222222-2222-4222-8222-222222222222'
const spec = (over: Partial<AgentSpec> = {}): AgentSpec => ({ name: 'helper', ...over })

function agentsDir(): string {
  return mkdtempSync(join(tmpdir(), 'ac-cpreg-'))
}
function readAgent(dir: string, id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, id, 'agent.json'), 'utf8'))
}
function makeReg(dir: string) {
  const onChange = vi.fn()
  const reg = new CpAgentRegistry(dir, { knownRuntimes: ['claude'], warn: vi.fn() }, onChange)
  return { reg, onChange }
}

describe('CpAgentRegistry (filesystem-backed)', () => {
  it('upsert CREATES a new agent.json when none exists and fires onChange', () => {
    const dir = agentsDir()
    const { reg, onChange } = makeReg(dir)
    reg.upsert(A1, spec({ description: 'be terse', model: 'opus' }))
    const a = readAgent(dir, 'helper') // fresh dir named by the agent's slug (spec.name), not its id
    expect(a.id).toBe(A1)
    expect(a.name).toBe('helper')
    expect(a.description).toBe('be terse')
    expect(a.runtime).toBe('claude') // default from knownRuntimes
    expect((a.runtimeOverrides as any).model).toBe('opus')
    expect((a.workspace as any).mode).toBe('from-scratch')
    expect((a.workspace as any).path).toBe(join(dir, 'helper', 'workspace')) // daemon-generated under the slug dir
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('upsert MERGES CP-owned fields into an existing agent.json, preserving local keys + relative path', () => {
    const dir = agentsDir()
    mkdirSync(join(dir, A1), { recursive: true })
    writeFileSync(
      join(dir, A1, 'agent.json'),
      JSON.stringify({
        id: A1,
        name: 'local',
        status: 'active',
        runtime: 'codex',
        workspace: { mode: 'from-scratch', path: './ws', pullOnNewSession: false, skills: ['git'] },
        integrations: [{ id: 'i1', platform: 'slack' }],
        runtimeOverrides: { model: 'old', env: [{ name: 'OLD', value: 'old-value' }] },
        permissions: { policy: 'auto', autoApprove: ['fs'] }
      })
    )
    const { reg } = makeReg(dir)
    reg.upsert(A1, spec({ name: 'cp-name', model: 'opus', env: { NEW: 'v' } }))
    const a = readAgent(dir, A1)
    // CP-owned merged
    expect(a.name).toBe('cp-name')
    expect((a.runtimeOverrides as any).model).toBe('opus')
    expect((a.runtimeOverrides as any).env).toEqual([{ name: 'NEW', value: 'v' }])
    // locally-owned preserved untouched
    expect(a.runtime).toBe('codex')
    expect(a.status).toBe('active')
    expect(a.integrations).toEqual([{ id: 'i1', platform: 'slack' }])
    expect(a.permissions).toEqual({ policy: 'auto', autoApprove: ['fs'] })
    // path stays relative (no absolute rewrite); pullOnNewSession + skills preserved
    expect((a.workspace as any).path).toBe('./ws')
    expect((a.workspace as any).pullOnNewSession).toBe(false)
    expect((a.workspace as any).skills).toEqual(['git'])
  })

  it('upsert maps output and chat runtime controls, leaving them alone when the spec omits them', () => {
    const dir = agentsDir()
    mkdirSync(join(dir, A1), { recursive: true })
    writeFileSync(
      join(dir, A1, 'agent.json'),
      JSON.stringify({
        id: A1,
        name: 'local',
        runtime: 'claude',
        workspace: { mode: 'from-scratch', path: './ws' },
        output: { mode: 'high', showFooter: true, showStatusBar: true },
        fastMode: true,
        allowRuntimeChangesInChat: true
      })
    )
    const { reg } = makeReg(dir)
    // spec without the fields: hand-authored values survive the merge
    reg.upsert(A1, spec({ model: 'opus' }))
    let a = readAgent(dir, A1)
    expect(a.output).toEqual({ mode: 'high', showFooter: true, showStatusBar: true })
    expect(a.fastMode).toBe(true)
    expect(a.allowRuntimeChangesInChat).toBe(true)
    // spec with the fields: CP-owned now, overwritten
    reg.upsert(
      A1,
      spec({
        outputMode: 'medium',
        showFooter: false,
        showStatusBar: false,
        fastMode: false,
        allowRuntimeChangesInChat: false
      })
    )
    a = readAgent(dir, A1)
    expect(a.output).toEqual({ mode: 'medium', showFooter: false, showStatusBar: false })
    expect(a.fastMode).toBe(false)
    expect(a.allowRuntimeChangesInChat).toBe(false)
  })

  it('upsert maps mcpServers onto agent.json (CP-owned; replace including the clear)', () => {
    const dir = agentsDir()
    const { reg } = makeReg(dir)
    reg.upsert(A1, spec({ mcpServers: ['files', 'search'] }))
    expect(readAgent(dir, 'helper').mcpServers).toEqual(['files', 'search'])
    // a later spec with an empty list clears the enablement (disable-all round-trips)
    reg.upsert(A1, spec({ mcpServers: [] }))
    expect(readAgent(dir, 'helper').mcpServers).toEqual([])
  })

  it('upsert replaces both directions of agent visibility, including cleared allow-lists', () => {
    const dir = agentsDir()
    const { reg } = makeReg(dir)
    reg.upsert(
      A1,
      spec({
        callPolicy: 'selected',
        allowedCallerAgentIds: [A2],
        outboundPolicy: 'selected',
        allowedTargetAgentIds: [A2]
      })
    )
    expect(readAgent(dir, 'helper')).toMatchObject({
      callPolicy: 'selected',
      allowedCallerAgentIds: [A2],
      outboundPolicy: 'selected',
      allowedTargetAgentIds: [A2]
    })

    reg.upsert(
      A1,
      spec({ callPolicy: 'all', allowedCallerAgentIds: [], outboundPolicy: 'all', allowedTargetAgentIds: [] })
    )
    expect(readAgent(dir, 'helper')).toMatchObject({
      callPolicy: 'all',
      allowedCallerAgentIds: [],
      outboundPolicy: 'all',
      allowedTargetAgentIds: []
    })
  })

  it('preserves the complete outbound half when a legacy spec omits it', () => {
    const dir = agentsDir()
    const { reg } = makeReg(dir)
    reg.upsert(A1, spec({ outboundPolicy: 'selected', allowedTargetAgentIds: [A2] }))

    reg.upsert(A1, spec({ callPolicy: 'all', allowedCallerAgentIds: [] }))

    expect(readAgent(dir, 'helper')).toMatchObject({
      outboundPolicy: 'selected',
      allowedTargetAgentIds: [A2]
    })
  })

  it('upsert workspace github maps mode + git fields but PRESERVES the existing path on update', () => {
    const dir = agentsDir()
    mkdirSync(join(dir, A1), { recursive: true })
    writeFileSync(
      join(dir, A1, 'agent.json'),
      JSON.stringify({
        id: A1,
        name: 'local',
        runtime: 'claude',
        workspace: { mode: 'from-scratch', path: './keep-me' }
      })
    )
    const { reg } = makeReg(dir)
    reg.upsert(A1, spec({ workspace: { mode: 'github', gitRepo: 'github.com/acme/x', branch: 'dev' } }))
    const ws = readAgent(dir, A1).workspace as any
    expect(ws.mode).toBe('git-repo')
    // shorthand from a pre-normalization CP row is persisted as the full address
    expect(ws.gitRepo).toBe('https://github.com/acme/x')
    expect(ws.gitBranch).toBe('dev')
    expect(ws.path).toBe('./keep-me') // never overwritten on update
  })

  it('persists a valid custom origin for daemon-local authorization at execution time', () => {
    const dir = agentsDir()
    const { reg } = makeReg(dir)

    reg.upsert(
      A1,
      spec({
        workspace: { mode: 'github', gitRepo: 'https://git.example/acme/repo.git', branch: 'main' }
      })
    )

    expect((readAgent(dir, 'helper').workspace as any).gitRepo).toBe('https://git.example/acme/repo.git')
  })

  it('upsert MERGES by internal id into a custom-named dir (dir name != id), not a duplicate at <dir>/<id>', () => {
    const dir = agentsDir()
    // hand-authored agent: id A1 but living under a differently-named folder
    mkdirSync(join(dir, 'my-cool-bot'), { recursive: true })
    writeFileSync(
      join(dir, 'my-cool-bot', 'agent.json'),
      JSON.stringify({ id: A1, name: 'local', runtime: 'codex', workspace: { mode: 'from-scratch', path: './ws' } })
    )
    const { reg } = makeReg(dir)
    reg.upsert(A1, spec({ name: 'cp-name', model: 'opus' }))
    // merged in place — NO duplicate created at <dir>/<A1>/agent.json
    expect(existsSync(join(dir, A1, 'agent.json'))).toBe(false)
    const a = JSON.parse(readFileSync(join(dir, 'my-cool-bot', 'agent.json'), 'utf8'))
    expect(a.name).toBe('cp-name')
    expect((a.runtimeOverrides as any).model).toBe('opus')
    expect(a.runtime).toBe('codex') // local key preserved
  })

  it('remove deletes by internal id even when the dir name != id', () => {
    const dir = agentsDir()
    mkdirSync(join(dir, 'my-cool-bot'), { recursive: true })
    writeFileSync(
      join(dir, 'my-cool-bot', 'agent.json'),
      JSON.stringify({ id: A1, name: 'local', runtime: 'codex', workspace: { mode: 'from-scratch', path: './ws' } })
    )
    const { reg } = makeReg(dir)
    reg.remove(A1)
    expect(existsSync(join(dir, 'my-cool-bot'))).toBe(false)
  })

  it('remove deletes the agent dir unconditionally and fires onChange', () => {
    const dir = agentsDir()
    const { reg, onChange } = makeReg(dir)
    reg.upsert(A1, spec())
    expect(existsSync(join(dir, 'helper', 'agent.json'))).toBe(true) // created under the slug dir
    onChange.mockClear()
    reg.remove(A1)
    expect(existsSync(join(dir, 'helper'))).toBe(false)
    expect(onChange).toHaveBeenCalledTimes(1)
    // removing an absent agent is a no-op (still fires onChange; force:true tolerates missing)
    reg.remove(A2)
    expect(existsSync(join(dir, A2))).toBe(false)
  })

  it('detach archives non-destructively and activate restores the original custom path', () => {
    const dir = agentsDir()
    const custom = join(dir, 'nested', 'custom-agent')
    mkdirSync(join(custom, 'workspace'), { recursive: true })
    writeFileSync(
      join(custom, 'agent.json'),
      JSON.stringify({
        id: A1,
        name: 'local',
        status: 'active',
        runtime: 'claude',
        workspace: { mode: 'from-scratch', path: './workspace' }
      })
    )
    writeFileSync(join(custom, 'workspace', 'keep.txt'), 'keep')
    const { reg, onChange } = makeReg(dir)

    expect(reg.detach(A1)).toBe('archived')
    expect(reg.detach(A1)).toBe('already-detached')
    expect(existsSync(custom)).toBe(false)
    expect(onChange).toHaveBeenCalledTimes(2)

    expect(reg.activate(A1, { integrationIds: [], cronIds: [] })).toBe('restored')
    expect(reg.activate(A1, { integrationIds: [], cronIds: [] })).toBe('already-active')
    expect(readFileSync(join(custom, 'workspace', 'keep.txt'), 'utf8')).toBe('keep')
    // already-active is a no-op; only the restore fires another reconcile.
    expect(onChange).toHaveBeenCalledTimes(3)
  })

  it('reports missing detach/activate without firing a reconcile', () => {
    const dir = agentsDir()
    const { reg, onChange } = makeReg(dir)
    expect(reg.detach(A1)).toBe('missing')
    expect(reg.activate(A1, { integrationIds: [], cronIds: [] })).toBe('missing')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('converge create-or-merges each roster entry and does NOT prune agents absent from the roster', () => {
    const dir = agentsDir()
    const { reg } = makeReg(dir)
    reg.upsert(A1, spec({ model: 'old' })) // present on disk (slug dir "helper"), absent from the next roster
    reg.converge([{ agentId: A2, name: 'assistant', model: 'opus' }]) // distinct slug — names are unique per org
    // A2 created from roster under its own slug dir
    expect((readAgent(dir, 'assistant').runtimeOverrides as any).model).toBe('opus')
    // A1 NOT pruned (deletion only via agent/remove)
    expect(existsSync(join(dir, 'helper', 'agent.json'))).toBe(true)
  })
})
