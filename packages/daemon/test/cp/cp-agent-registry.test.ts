import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSpec } from '@agentconnect.md/protocol'
import { CpAgentRegistry } from '../../src/cp/cp-agent-registry.js'

const A1 = '11111111-1111-4111-8111-111111111111'
const A2 = '22222222-2222-4222-8222-222222222222'
const spec = (over: Partial<AgentSpec> = {}) => ({ name: 'helper', runtime: 'claude', ...over }) as AgentSpec

function makeReg(dir = mkdtempSync(join(tmpdir(), 'ac-cpreg-'))) {
  const onChange = vi.fn()
  const reg = new CpAgentRegistry(dir, { knownRuntimes: ['claude'], warn: vi.fn() }, onChange)
  return { dir, reg, onChange }
}

function writeLocal(dir: string, folder: string, id: string, extra: Record<string, unknown> = {}): string {
  const root = join(dir, folder)
  mkdirSync(root, { recursive: true })
  const file = join(root, 'agent.json')
  writeFileSync(
    file,
    JSON.stringify({
      id,
      name: folder,
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: './workspace' },
      ...extra
    })
  )
  return file
}

describe('CpAgentRegistry (memory-only CP specs)', () => {
  it('creates an effective agent without writing agent.json', () => {
    const { dir, reg, onChange } = makeReg()
    reg.upsert(A1, spec({ description: 'be terse', model: 'opus' }))

    expect(reg.agents()).toHaveLength(1)
    expect(reg.agents()[0]).toMatchObject({
      id: A1,
      name: 'helper',
      origin: 'cp',
      description: 'be terse',
      runtimeOverrides: { model: 'opus' }
    })
    expect(existsSync(join(dir, 'helper', 'agent.json'))).toBe(false)
    expect(readFileSync(join(dir, 'helper', '.cp-agent-id'), 'utf8').trim()).toBe(A1)
    expect(onChange).toHaveBeenCalledOnce()
  })

  it('deletes only the same-id agent.json and preserves every other local file', () => {
    const { dir, reg } = makeReg()
    const matching = writeLocal(dir, 'custom', A1, { description: 'legacy' })
    const duplicate = writeLocal(dir, 'duplicate', A1)
    const other = writeLocal(dir, 'user-agent', A2, { origin: 'cp' })
    writeFileSync(join(dir, 'custom', 'keep.txt'), 'workspace data')

    reg.upsert(A1, spec({ description: 'current' }))

    expect(existsSync(matching)).toBe(false)
    expect(existsSync(duplicate)).toBe(false)
    expect(readFileSync(join(dir, 'custom', 'keep.txt'), 'utf8')).toBe('workspace data')
    expect(existsSync(other)).toBe(true)
    expect(JSON.parse(readFileSync(other, 'utf8')).id).toBe(A2)
    expect(reg.agents()[0]).toMatchObject({ id: A1, description: 'current', dir: join(dir, 'custom') })
  })

  it('never claims or removes agentsDir when the matching agent.json is at its root', () => {
    const { dir, reg } = makeReg()
    const matching = join(dir, 'agent.json')
    writeFileSync(
      matching,
      JSON.stringify({
        id: A1,
        name: 'root-local',
        runtime: 'claude',
        workspace: { mode: 'from-scratch', path: './workspace' }
      })
    )
    const other = writeLocal(dir, 'other-local', A2)

    reg.upsert(A1, spec())

    expect(existsSync(matching)).toBe(false)
    expect(existsSync(join(dir, '.cp-agent-id'))).toBe(false)
    expect(reg.agents()[0]?.dir).toBe(join(dir, 'helper'))
    reg.remove(A1)
    expect(existsSync(dir)).toBe(true)
    expect(existsSync(other)).toBe(true)
  })

  it('allocates a new child when both the preferred and fallback roots are occupied', () => {
    const { dir, reg } = makeReg()
    const fallback = join(dir, `agent-${createHash('sha256').update(A1).digest('hex').slice(0, 32)}`)
    mkdirSync(join(dir, 'helper'), { recursive: true })
    mkdirSync(fallback, { recursive: true })
    writeFileSync(join(dir, 'helper', 'keep'), 'preferred')
    writeFileSync(join(fallback, 'keep'), 'fallback')

    reg.upsert(A1, spec())

    expect(reg.agents()[0]?.dir).toBe(`${fallback}-2`)
    expect(readFileSync(join(dir, 'helper', 'keep'), 'utf8')).toBe('preferred')
    expect(readFileSync(join(fallback, 'keep'), 'utf8')).toBe('fallback')
  })

  it('keeps CP values in memory across partial updates and never recreates agent.json', () => {
    const { dir, reg } = makeReg()
    reg.upsert(A1, spec({ model: 'opus', outputMode: 'high', allowedCallerAgentIds: [A2] }))
    reg.upsert(A1, spec({ model: null, showFooter: false }))

    const agent = reg.agents()[0]!
    expect(agent.runtimeOverrides?.model).toBeUndefined()
    expect(agent.output).toEqual({ mode: 'high', showFooter: false, showStatusBar: false })
    expect(agent.allowedCallerAgentIds).toEqual([A2])
    expect(existsSync(join(agent.dir, 'agent.json'))).toBe(false)
  })

  it('reuses the secret-free root marker after a registry restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-cpreg-'))
    const first = makeReg(dir).reg
    first.upsert(A1, spec())
    writeFileSync(join(dir, 'helper', 'workspace-data'), 'keep')

    const second = makeReg(dir).reg
    second.upsert(A1, spec({ name: 'renamed' }))
    expect(second.agents()[0]?.dir).toBe(join(dir, 'helper'))
    expect(readFileSync(join(dir, 'helper', 'workspace-data'), 'utf8')).toBe('keep')
    expect(existsSync(join(dir, 'helper', 'agent.json'))).toBe(false)
  })

  it('fences stale/equal revisions in memory', () => {
    const { reg } = makeReg()
    expect(reg.upsert(A1, spec({ configRevision: '2', description: 'new' }))).toBe('apply')
    expect(reg.upsert(A1, spec({ configRevision: '1', description: 'old' }))).toBe('stale')
    expect(reg.upsert(A1, spec({ configRevision: '2', description: 'new' }))).toBe('idempotent')
    expect(reg.upsert(A1, spec({ configRevision: '2', description: 'different' }))).toBe('conflict')
    expect(reg.agents()[0]?.description).toBe('new')
  })

  it('detach/activate changes only in-memory visibility and remove deletes its owned data root', () => {
    const { dir, reg } = makeReg()
    reg.upsert(A1, spec())
    expect(reg.detach(A1)).toBe('archived')
    expect(reg.agents()).toEqual([])
    expect(existsSync(join(dir, 'helper'))).toBe(true)
    expect(reg.activate(A1, { integrationIds: [], cronIds: [] })).toBe('restored')
    expect(reg.agents()).toHaveLength(1)
    reg.remove(A1)
    expect(existsSync(join(dir, 'helper'))).toBe(false)
  })

  // The failure is forced by revoking directory permissions, which a Windows chmod cannot express.
  it.skipIf(process.platform === 'win32')('keeps removal retryable when deleting the owned root fails', () => {
    const { dir, reg } = makeReg()
    reg.upsert(A1, spec())
    const root = join(dir, 'helper')
    writeFileSync(join(root, 'keep'), 'data')
    chmodSync(root, 0o500)
    try {
      expect(() => reg.remove(A1)).toThrow()
      expect(reg.agents()).toHaveLength(1)
    } finally {
      chmodSync(root, 0o700)
    }
    expect(() => reg.remove(A1)).not.toThrow()
    expect(existsSync(root)).toBe(false)
  })

  it('inventories and removes a marker-only root after registry restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-cpreg-'))
    makeReg(dir).reg.upsert(A1, spec())

    const restarted = makeReg(dir).reg
    expect(restarted.agents()).toEqual([])
    expect(restarted.replicaIds()).toEqual([A1])
    restarted.remove(A1)
    expect(existsSync(join(dir, 'helper'))).toBe(false)
    expect(restarted.replicaIds()).toEqual([])
  })

  it('converge upserts roster entries without pruning unrelated local agent.json files', () => {
    const { dir, reg } = makeReg()
    const local = writeLocal(dir, 'local-only', 'local-only')
    reg.converge([
      { agentId: A1, ...spec() },
      { agentId: A2, ...spec({ name: 'other' }) }
    ])
    expect(
      reg
        .agents()
        .map((agent) => agent.id)
        .sort()
    ).toEqual([A1, A2])
    expect(existsSync(local)).toBe(true)
  })
})
