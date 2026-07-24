import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CronUpsert } from '@agentconnect.md/protocol'
import { CpCronRegistry } from '../../src/cp/cp-cron.js'

const A1 = '11111111-1111-4111-8111-111111111111'
const C1 = '66666666-6666-4666-8666-666666666666'
const C2 = '77777777-7777-4777-8777-777777777777'

const cron = (over: Partial<CronUpsert> = {}): CronUpsert => ({
  cronId: C1,
  agentId: A1,
  schedule: '0 9 * * *',
  timezone: 'Asia/Singapore',
  target: { platform: 'slack', channel: 'C0TEAM' },
  trigger: 'post the daily report',
  enabled: true,
  ...over
})

function agentsDir(): string {
  return mkdtempSync(join(tmpdir(), 'ac-cpcronreg-'))
}
function writeAgentFile(dir: string, folder: string, raw: Record<string, unknown>) {
  mkdirSync(join(dir, folder), { recursive: true })
  writeFileSync(join(dir, folder, 'agent.json'), JSON.stringify(raw))
}
function readAgent(dir: string, folder: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, folder, 'agent.json'), 'utf8'))
}
function makeReg(dir: string) {
  const onChange = vi.fn()
  const warn = vi.fn()
  const reg = new CpCronRegistry(dir, { warn }, onChange)
  return { reg, onChange, warn }
}

const AGENT_RAW = {
  id: A1,
  name: 'helper',
  runtime: 'claude',
  workspace: { mode: 'from-scratch', path: './ws' }
}

describe('CpCronRegistry (agent.json-backed)', () => {
  it('upsert APPENDS the cron to the owning agent.json (origin:"cp") and fires onChange', () => {
    const dir = agentsDir()
    writeAgentFile(dir, 'helper', AGENT_RAW)
    const { reg, onChange } = makeReg(dir)
    reg.upsert(cron())
    const a = readAgent(dir, 'helper')
    expect(a.crons).toEqual([
      {
        id: C1,
        schedule: '0 9 * * *',
        timezone: 'Asia/Singapore',
        target: { platform: 'slack', channel: 'C0TEAM' },
        trigger: 'post the daily report',
        enabled: true,
        origin: 'cp'
      }
    ])
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('a target-less def persists without target (headless) and re-applying identically skips the write', () => {
    const dir = agentsDir()
    writeAgentFile(dir, 'helper', AGENT_RAW)
    const { reg, onChange } = makeReg(dir)
    const def = cron({ target: undefined })
    reg.upsert(def)
    expect((readAgent(dir, 'helper').crons as any[])[0].target).toBeUndefined()
    expect(onChange).toHaveBeenCalledTimes(1)
    reg.upsert(def) // identical re-apply (every register/ok converge re-sends)
    reg.converge([def])
    expect(onChange).toHaveBeenCalledTimes(1) // no watcher churn
  })

  it('a target with integrationId persists it — the anchor posts through that integration', () => {
    const dir = agentsDir()
    writeAgentFile(dir, 'helper', AGENT_RAW)
    const { reg } = makeReg(dir)
    const I1 = '88888888-8888-4888-8888-888888888888'
    reg.upsert(cron({ target: { platform: 'slack', channel: 'C0TEAM', integrationId: I1 } }))
    expect((readAgent(dir, 'helper').crons as any[])[0].target).toEqual({
      platform: 'slack',
      channel: 'C0TEAM',
      integrationId: I1
    })
  })

  it('upsert REPLACES the same-id entry and preserves hand-authored crons', () => {
    const dir = agentsDir()
    writeAgentFile(dir, 'helper', {
      ...AGENT_RAW,
      crons: [
        { id: C1, schedule: '0 0 * * *', trigger: 'old', origin: 'cp' },
        { id: 'hand-written', schedule: '*/5 * * * *', trigger: 'user cron' }
      ]
    })
    const { reg } = makeReg(dir)
    reg.upsert(cron({ enabled: false }))
    const list = readAgent(dir, 'helper').crons as any[]
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ id: C1, enabled: false, origin: 'cp' })
    expect(list[1]).toEqual({ id: 'hand-written', schedule: '*/5 * * * *', trigger: 'user cron' })
  })

  it('upsert never overwrites a hand-authored cron sharing the id — warns and leaves it', () => {
    const dir = agentsDir()
    writeAgentFile(dir, 'helper', {
      ...AGENT_RAW,
      crons: [{ id: C1, schedule: '*/5 * * * *', trigger: 'user cron' }] // NO origin
    })
    const { reg, onChange, warn } = makeReg(dir)
    reg.upsert(cron()) // same id, origin:"cp"
    const list = readAgent(dir, 'helper').crons as any[]
    expect(list).toEqual([{ id: C1, schedule: '*/5 * * * *', trigger: 'user cron' }]) // untouched
    expect(warn).toHaveBeenCalledOnce()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('remove splices out only the origin:"cp" entry with that id', () => {
    const dir = agentsDir()
    writeAgentFile(dir, 'helper', {
      ...AGENT_RAW,
      crons: [
        { id: C1, schedule: '0 0 * * *', trigger: 't', origin: 'cp' },
        { id: C2, schedule: '0 1 * * *', trigger: 'user-owned same-shape' } // NO origin — never CP-deleted
      ]
    })
    const { reg, onChange } = makeReg(dir)
    reg.remove(C1)
    expect((readAgent(dir, 'helper').crons as any[]).map((c) => c.id)).toEqual([C2])
    reg.remove(C2) // user entry: not eligible
    expect((readAgent(dir, 'helper').crons as any[]).map((c) => c.id)).toEqual([C2])
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('an orphan cron (agent not on disk) warns and is not persisted', () => {
    const dir = agentsDir()
    const { reg, onChange, warn } = makeReg(dir)
    reg.upsert(cron())
    expect(warn).toHaveBeenCalledOnce()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('converge upserts each entry across owning agents in one onChange', () => {
    const dir = agentsDir()
    writeAgentFile(dir, 'helper', AGENT_RAW)
    const A2 = '22222222-2222-4222-8222-222222222222'
    writeAgentFile(dir, 'other', { ...AGENT_RAW, id: A2, name: 'other' })
    const { reg, onChange } = makeReg(dir)
    reg.converge([cron(), cron({ cronId: C2, agentId: A2, target: undefined })])
    expect((readAgent(dir, 'helper').crons as any[]).map((c) => c.id)).toEqual([C1])
    expect((readAgent(dir, 'other').crons as any[]).map((c) => c.id)).toEqual([C2])
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})
