// An agent's own crons: only those bound to it, a one-shot stored as wall-clock time and retired after its run.
import { describe, expect, it, vi } from 'vitest'
import { AgentId, CronId, IntegrationId, OrgId } from '../domain/ids.js'
import type { AgentRecord, CronRecord, IntegrationRecord, UpsertCronInput } from '../persistence/ports.js'
import { AgentCronService, wallClockIn } from './agentCrons.js'

const ORG = OrgId('org-1')
const AGENT = AgentId('3c4d5e6f-7081-4293-a4b5-c6d7e8f90a1b')
const OTHER = AgentId('4d5e6f70-8192-4a3b-b5c6-d7e8f90a1b2c')
const INTEGRATION = IntegrationId('0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d')
const NOW = new Date('2026-11-11T00:00:00Z')

const agent = { id: AGENT, orgId: ORG, lastModifiedAt: NOW } as unknown as AgentRecord

function row(input: UpsertCronInput): CronRecord {
  return {
    id: input.cronId,
    orgId: input.orgId,
    agentId: input.agentId,
    name: input.name ?? null,
    schedule: input.schedule,
    timezone: input.timezone,
    targetPlatform: input.targetPlatform ?? 'slack',
    targetChannel: input.targetChannel ?? null,
    targetIntegrationId: input.targetIntegrationId ?? null,
    trigger: input.trigger,
    enabled: input.enabled ?? true,
    lastRunAt: null,
    createdBy: null,
    createdByUserId: null,
    visibility: 'org',
    sharedWith: [],
    createdAt: NOW,
    lastModifiedAt: NOW,
    lastModifiedBy: null
  } as CronRecord
}

function harness(existing: CronRecord[] = []) {
  const crons = new Map(existing.map((c) => [c.id as string, c]))
  const delivery = { cronUpsert: vi.fn(async () => {}), cronRemove: vi.fn(async () => {}) }
  const service = new AgentCronService({
    crons: {
      get: async (_org, id) => crons.get(id) ?? null,
      upsert: async (input) => {
        const saved = row(input)
        crons.set(saved.id, saved)
        return saved
      },
      remove: async (_org, id, expected, definition) => {
        const row = crons.get(id)
        if (row?.agentId !== expected) return false
        if (definition && (row.schedule !== definition.schedule || row.timezone !== definition.timezone)) return false
        return crons.delete(id)
      },
      listForAgent: async (id) => [...crons.values()].filter((c) => c.agentId === id)
    },
    agents: { get: async () => agent },
    integrations: {
      get: async (_org, id) =>
        id === INTEGRATION ? ({ id, agentId: AGENT, platform: 'slack' } as unknown as IntegrationRecord) : null
    },
    audit: { append: async () => ({}) as never },
    delivery,
    mutations: { tryBeginMutation: () => () => {} },
    now: () => NOW,
    log: { warn: () => {} }
  })
  return { service, crons, delivery }
}

describe('an agent’s own crons', () => {
  it('stores a one-shot as wall-clock time in its timezone and pushes it', async () => {
    const { service, delivery } = harness()
    const result = await service.save(agent, {
      runAt: '2026-11-12T09:00:00+08:00',
      timezone: 'Asia/Shanghai',
      trigger: 'check the deploy',
      target: { integrationId: INTEGRATION, channel: 'C1' }
    })
    expect(result).toMatchObject({
      status: 'ok',
      cron: { schedule: '2026-11-12T09:00:00', once: true, target: { channel: 'C1', integrationId: INTEGRATION } }
    })
    expect(delivery.cronUpsert).toHaveBeenCalledOnce()
    expect(wallClockIn(new Date('2026-11-12T01:00:00Z'), 'America/New_York')).toBe('2026-11-11T20:00:00')
  })

  it('refuses a past runAt, a bad schedule, both or neither, and a foreign integration', async () => {
    const { service, crons } = harness()
    const base = { timezone: 'UTC', trigger: 'p' }
    for (const input of [
      { ...base, runAt: '2026-11-10T00:00:00Z' },
      { ...base, schedule: 'not a cron' },
      { ...base },
      { ...base, schedule: '0 9 * * *', runAt: '2026-11-12T00:00:00Z' },
      { ...base, schedule: '2026-11-12T09:00:00' },
      { ...base, schedule: '0 9 * * *', target: { integrationId: OTHER, channel: 'C1' } },
      { ...base, schedule: '0 9 * * *', timezone: 'Mars/Olympus' }
    ])
      expect((await service.save(agent, input)).status).toBe('refused')
    expect(crons.size).toBe(0)
  })

  it('edits and deletes any cron bound to it, never another agent’s', async () => {
    const mine = row({
      cronId: CronId('7f3a1c56-8a2b-4c3d-9e4f-0a1b2c3d4e5f'),
      orgId: ORG,
      agentId: AGENT,
      schedule: '0 9 * * *',
      timezone: 'UTC',
      trigger: 'a',
      targetChannel: 'C9',
      targetIntegrationId: INTEGRATION
    })
    const theirs = row({
      cronId: CronId('8a4b2d67-9b3c-4d4e-8f5a-1b2c3d4e5f6a'),
      orgId: ORG,
      agentId: OTHER,
      schedule: '0 9 * * *',
      timezone: 'UTC',
      trigger: 'b'
    })
    const { service, crons } = harness([mine, theirs])
    const edited = await service.save(agent, {
      cronId: mine.id,
      schedule: '0 10 * * *',
      timezone: 'UTC',
      trigger: 'a2'
    })
    expect(edited).toMatchObject({ status: 'ok', cron: { schedule: '0 10 * * *', target: { channel: 'C9' } } })
    const headless = await service.save(agent, {
      cronId: mine.id,
      schedule: '0 10 * * *',
      timezone: 'UTC',
      trigger: 'a2',
      target: null
    })
    expect(headless.cron?.target).toBeNull()
    expect(
      (await service.save(agent, { cronId: theirs.id, schedule: '0 10 * * *', timezone: 'UTC', trigger: 'x' })).status
    ).toBe('refused')
    expect((await service.remove(agent, theirs.id)).status).toBe('refused')
    expect((await service.list(agent)).crons?.map((c) => c.cronId)).toEqual([mine.id])
    expect((await service.remove(agent, mine.id)).status).toBe('ok')
    expect([...crons.keys()]).toEqual([theirs.id])
  })

  it('retires a one-shot after its run, and leaves a recurring cron alone', async () => {
    const once = row({
      cronId: CronId('7f3a1c56-8a2b-4c3d-9e4f-0a1b2c3d4e5f'),
      orgId: ORG,
      agentId: AGENT,
      schedule: '2026-11-12T09:00:00',
      timezone: 'UTC',
      trigger: 'a'
    })
    const daily = row({
      cronId: CronId('8a4b2d67-9b3c-4d4e-8f5a-1b2c3d4e5f6a'),
      orgId: ORG,
      agentId: AGENT,
      schedule: '0 9 * * *',
      timezone: 'UTC',
      trigger: 'b'
    })
    const fired = new Date('2026-11-12T09:00:00Z')
    const { service, crons, delivery } = harness([once, daily])
    await service.retireOneShot(once, fired)
    await service.retireOneShot(daily, fired)
    expect([...crons.keys()]).toEqual([daily.id])
    expect(delivery.cronRemove).toHaveBeenCalledOnce()
  })

  it('does not retire a one-shot whose definition a concurrent save replaced', async () => {
    const fired = new Date('2026-11-12T09:00:00Z')
    const firedRow = row({
      cronId: CronId('7f3a1c56-8a2b-4c3d-9e4f-0a1b2c3d4e5f'),
      orgId: ORG,
      agentId: AGENT,
      schedule: '2026-11-12T09:00:00',
      timezone: 'UTC',
      trigger: 'a'
    })
    const replacement = row({
      cronId: CronId('7f3a1c56-8a2b-4c3d-9e4f-0a1b2c3d4e5f'),
      orgId: ORG,
      agentId: AGENT,
      schedule: '0 9 * * *',
      timezone: 'UTC',
      trigger: 'replaced'
    })
    // The report read the fired row; a save replaced it before the delete ran.
    const stored = new Map([[replacement.id, replacement]])
    const service = new AgentCronService({
      crons: {
        get: async () => firedRow,
        upsert: async () => firedRow,
        remove: async (_org, id, expected, definition) => {
          const row = stored.get(id)
          if (row?.agentId !== expected) return false
          if (definition && (row.schedule !== definition.schedule || row.timezone !== definition.timezone)) return false
          return stored.delete(id)
        },
        listForAgent: async () => []
      },
      agents: { get: async () => agent },
      integrations: { get: async () => null },
      audit: { append: async () => ({}) as never },
      delivery: { cronUpsert: async () => {}, cronRemove: async () => {} } as unknown as never,
      mutations: { tryBeginMutation: () => () => {} },
      now: () => NOW,
      log: { warn: () => {} }
    })
    await service.retireOneShot(firedRow, fired)
    expect(stored.get(replacement.id)?.schedule).toBe('0 9 * * *')
  })

  it('does not retire a one-shot rescheduled while a run was in flight', async () => {
    const fired = new Date('2026-11-12T09:00:00Z')
    const later = row({
      cronId: CronId('7f3a1c56-8a2b-4c3d-9e4f-0a1b2c3d4e5f'),
      orgId: ORG,
      agentId: AGENT,
      schedule: '2026-11-13T09:00:00',
      timezone: 'Asia/Shanghai',
      trigger: 'moved'
    })
    const { service, crons, delivery } = harness([later])
    await service.retireOneShot(later, fired)
    expect([...crons.keys()]).toEqual([later.id])
    expect(delivery.cronRemove).not.toHaveBeenCalled()
  })
})
