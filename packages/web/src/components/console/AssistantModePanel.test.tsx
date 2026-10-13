// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const AGENT = '22222222-2222-4222-8222-222222222222'
const INTEGRATION = '33333333-3333-4333-8333-333333333333'

type Row = { channelId: string; name: string; kind?: 'channel' | 'im' | 'mpim'; trigger: string }

const mocks = vi.hoisted(() => ({
  updateAgent: vi.fn(),
  admission: { admitted: true, refusals: [] as string[] },
  responsible: vi.fn(async (): Promise<{ userId: string | null }> => ({ userId: 'usr_1' })),
  channels: [] as Row[]
}))

vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    updateAgent: mocks.updateAgent,
    members: [
      {
        userId: 'usr_1',
        email: 'ada@example.test',
        name: 'Ada',
        picture: null,
        role: 'owner',
        isCurrentUser: true,
        joinedAt: '2026-01-01T00:00:00.000Z'
      }
    ],
    integrations: [
      {
        id: INTEGRATION,
        agentId: AGENT,
        name: 'team',
        platform: 'slack',
        kind: 'Custom app',
        workspace: 'example.test',
        daemon: 'edge',
        status: 'online',
        revoked: false,
        get channels() {
          return mocks.channels
        }
      }
    ]
  })
}))

vi.mock('@/lib/api', () => ({
  fetchAgentAssistantModeAdmission: vi.fn(async () => mocks.admission),
  fetchAgentAssistantResponsibleUser: mocks.responsible,
  memberDisplayName: (m: { name: string | null }) => m.name ?? 'Member'
}))

import { AssistantModePanel, assistantModeDraft, assistantModePolicyForDraft } from './AssistantModePanel'

let root: Root | undefined
let container: HTMLDivElement | undefined

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

beforeEach(() => {
  mocks.updateAgent.mockReset().mockResolvedValue(undefined)
  mocks.admission = { admitted: true, refusals: [] }
  mocks.responsible.mockReset().mockResolvedValue({ userId: 'usr_1' })
  mocks.channels = [
    { channelId: 'C1', name: 'general', trigger: 'off' },
    { channelId: 'D1', name: '@ada', kind: 'im', trigger: 'any' }
  ]
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

async function mount(props: Partial<Parameters<typeof AssistantModePanel>[0]> = {}) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <AssistantModePanel
        agentId={AGENT}
        canEdit
        runtime="claude-acp"
        memoryProvider="managed"
        placement="daemon:edge"
        permissionMode=""
        askEveryTime={false}
        {...props}
      />
    )
  })
  return container
}

const clickButton = async (host: HTMLElement, label: string) => {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label)
  expect(button, `${label} button`).toBeTruthy()
  await act(async () => button?.click())
}

describe('assistant mode draft', () => {
  it('round-trips a policy and keeps the fields the panel does not edit', () => {
    const persisted = { enabled: true, instructions: 'Keep it short.', limits: { permissionWaitHours: 24 } }
    const draft = assistantModeDraft(persisted)
    expect(assistantModePolicyForDraft(draft, persisted)).toEqual(persisted)
    expect(
      assistantModePolicyForDraft({ ...draft, limits: { ...draft.limits, permissionWaitHours: '' } }, persisted)
    ).toEqual({ enabled: true, instructions: 'Keep it short.' })
  })

  it('needs nothing but the switch to turn on, and names a limit out of range', () => {
    const draft = assistantModeDraft(undefined)
    expect(assistantModePolicyForDraft({ ...draft, enabled: true }, undefined)).toEqual({ enabled: true })
    expect(
      assistantModePolicyForDraft({ ...draft, limits: { ...draft.limits, dailyPatrolBudget: '501' } }, undefined)
    ).toBe('invalidLimit')
    expect(assistantModePolicyForDraft(draft, undefined)).toEqual({ enabled: false })
  })
})

describe('AssistantModePanel', () => {
  it('locks the switch with each reason when admission fails', async () => {
    mocks.admission = { admitted: false, refusals: ['runtime-not-admitted', 'memory-provider'] }
    const host = await mount({ runtime: 'codex-acp', memoryProvider: 'native' })
    expect(host.querySelector('[data-assistant-mode-locked]')).toBeTruthy()
    expect(
      [...host.querySelectorAll('[data-assistant-mode-refusal]')].map((n) =>
        n.getAttribute('data-assistant-mode-refusal')
      )
    ).toEqual(['runtime-not-admitted', 'memory-provider'])
    await clickButton(host, 'Edit')
    const toggle = host.querySelector<HTMLInputElement>('input[type="checkbox"]')
    expect(toggle?.disabled).toBe(true)
  })

  it('turns on with the switch alone and saves the policy', async () => {
    const host = await mount()
    await clickButton(host, 'Edit')
    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click())
    await clickButton(host, 'Save assistant mode')
    expect(mocks.updateAgent).toHaveBeenCalledWith(AGENT, { assistantMode: { enabled: true } })
  })

  // assistant-mode.md §5.1: the responsible user is derived, so it is shown, never chosen.
  it('shows the derived responsible user read-only, with no responsible-user or fallback select', async () => {
    const on = await mount({ assistantMode: { enabled: true } })
    expect(mocks.responsible).toHaveBeenCalledWith(AGENT)
    expect(on.textContent).toContain('On · Responsible: Ada')
    await clickButton(on, 'Edit')
    expect(on.querySelectorAll('select')).toHaveLength(0)
    expect(on.textContent).not.toContain('Responsible user')
    expect(on.textContent).not.toContain('Fallback conversation')

    await act(async () => root?.unmount())
    root = undefined
    mocks.responsible.mockClear()
    const off = await mount()
    expect(mocks.responsible).not.toHaveBeenCalled()
    expect(off.textContent).not.toContain('Responsible:')
  })

  it('names nobody when the Control Plane derives no one', async () => {
    mocks.responsible.mockResolvedValue({ userId: null })
    const host = await mount({ assistantMode: { enabled: true } })
    expect(host.textContent).not.toContain('Responsible:')
  })

  // #2979 B7: turning on gates nothing, so it saves at once over rooms and group DMs already enabled.
  it('turns on over enabled rooms and group DMs with no warning', async () => {
    mocks.channels = [
      { channelId: 'C1', name: 'general', trigger: 'mention' },
      { channelId: 'C2', name: 'random', trigger: 'off' },
      { channelId: 'G1', name: '@ada, bob', kind: 'mpim', trigger: 'mention' },
      { channelId: 'D1', name: '@ada', kind: 'im', trigger: 'any' }
    ]
    const host = await mount()
    await clickButton(host, 'Edit')
    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click())
    await clickButton(host, 'Save assistant mode')
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(mocks.updateAgent).toHaveBeenCalledWith(AGENT, { assistantMode: { enabled: true } })
  })

  // assistant-mode.md §5.9: patrols run on the agent's own host, so they are marked degraded while the mode is on.
  it('marks patrols as degraded only while assistant mode is on', async () => {
    const on = await mount({ assistantMode: { enabled: true } })
    const label = on.querySelector('[data-assistant-patrols]')
    expect(label?.getAttribute('data-assistant-patrols')).toBe('degraded')
    expect(label?.textContent).toBe('Patrols degraded')
    expect(label?.getAttribute('title')).toContain('read-only')

    await act(async () => root?.unmount())
    root = undefined
    const off = await mount()
    expect(off.querySelector('[data-assistant-patrols]')).toBeNull()
  })

  it('warns when the agent asks before every action', async () => {
    const host = await mount({ askEveryTime: true, assistantMode: { enabled: true } })
    expect(host.querySelector('[data-assistant-mode-ask-warning]')?.textContent).toContain('wait for approval')
  })

  // assistant-mode.md §1.8: turning on moves an asking mode to the runtime's auto mode, so only a kept mode warns first.
  it('warns while turning on only when the runtime keeps the asking mode', async () => {
    const turningOn = async (props: Partial<Parameters<typeof AssistantModePanel>[0]>) => {
      const host = await mount({ askEveryTime: true, permissionMode: 'default', ...props })
      await clickButton(host, 'Edit')
      await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click())
      const warned = host.querySelector('[data-assistant-mode-ask-warning]') !== null
      await act(async () => root?.unmount())
      root = undefined
      return warned
    }
    expect(await turningOn({})).toBe(false)
    expect(await turningOn({ permissionMode: '' })).toBe(false)
    expect(await turningOn({ runtime: 'example-runtime' })).toBe(true)
  })
})
