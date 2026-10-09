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
  memberDisplayName: (m: { name: string | null }) => m.name ?? 'Member'
}))

import { AssistantModePanel, assistantModeDraft, assistantModePolicyForDraft } from './AssistantModePanel'

let root: Root | undefined
let container: HTMLDivElement | undefined

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

beforeEach(() => {
  mocks.updateAgent.mockReset().mockResolvedValue(undefined)
  mocks.admission = { admitted: true, refusals: [] }
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

const select = async (element: HTMLSelectElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(element, value)
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('assistant mode draft', () => {
  it('round-trips a policy and keeps the fields the panel does not edit', () => {
    const persisted = {
      enabled: true,
      responsibleUserId: 'usr_1',
      instructions: 'Keep it short.',
      limits: { permissionWaitHours: 24 }
    }
    const draft = assistantModeDraft(persisted)
    expect(assistantModePolicyForDraft(draft, persisted)).toEqual(persisted)
    expect(
      assistantModePolicyForDraft(
        {
          ...draft,
          responsibleUserId: '',
          fallback: `${INTEGRATION}\u0000C1`,
          limits: { ...draft.limits, permissionWaitHours: '' }
        },
        persisted
      )
    ).toEqual({
      enabled: true,
      instructions: 'Keep it short.',
      fallbackConversation: { integrationId: INTEGRATION, channelId: 'C1' }
    })
  })

  it('names why a draft cannot be saved', () => {
    const draft = assistantModeDraft(undefined)
    expect(assistantModePolicyForDraft({ ...draft, enabled: true }, undefined)).toBe('needsTarget')
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

  it('turns on with a responsible user and saves the policy', async () => {
    const host = await mount()
    await clickButton(host, 'Edit')
    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click())
    const save = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === 'Save assistant mode'
    )
    expect(save?.disabled).toBe(true)
    await select(host.querySelectorAll<HTMLSelectElement>('select')[0]!, 'usr_1')
    await clickButton(host, 'Save assistant mode')
    expect(mocks.updateAgent).toHaveBeenCalledWith(AGENT, {
      assistantMode: { enabled: true, responsibleUserId: 'usr_1' }
    })
  })

  // assistant-mode.md §5.1: turning on trusts the rooms and group DMs already enabled, so the switch names them first.
  it('warns before turning on over enabled rooms and group DMs, and saves only once confirmed', async () => {
    mocks.channels = [
      { channelId: 'C1', name: 'general', trigger: 'mention' },
      { channelId: 'C2', name: 'random', trigger: 'off' },
      { channelId: 'G1', name: '@ada, bob', kind: 'mpim', trigger: 'mention' },
      { channelId: 'D1', name: '@ada', kind: 'im', trigger: 'any' }
    ]
    const host = await mount()
    await clickButton(host, 'Edit')
    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click())
    await select(host.querySelectorAll<HTMLSelectElement>('select')[0]!, 'usr_1')
    await clickButton(host, 'Save assistant mode')
    expect(mocks.updateAgent).not.toHaveBeenCalled()
    const dialog = host.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('Turn on assistant mode?')
    expect(dialog?.textContent).toContain('Everyone here will be able to get the content of this agent’s other places')
    expect([...host.querySelectorAll('[data-assistant-place-list] li')].map((li) => li.textContent)).toEqual([
      'team · #general',
      'team · ada, bob'
    ])
    await clickButton(host, 'Turn on')
    expect(mocks.updateAgent).toHaveBeenCalledWith(AGENT, {
      assistantMode: { enabled: true, responsibleUserId: 'usr_1' }
    })
    expect(host.querySelector('[role="dialog"]')).toBeNull()
  })

  it('saves without the warning when already on, and when cancelled saves nothing', async () => {
    mocks.channels = [{ channelId: 'C1', name: 'general', trigger: 'mention' }]
    const on = await mount({ assistantMode: { enabled: true, responsibleUserId: 'usr_1' } })
    await clickButton(on, 'Edit')
    await act(async () => {
      const input = on.querySelector<HTMLInputElement>('input[data-assistant-mode-limit="dailyPatrolBudget"]')!
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '10')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await clickButton(on, 'Save assistant mode')
    expect(on.querySelector('[role="dialog"]')).toBeNull()
    expect(mocks.updateAgent).toHaveBeenCalledTimes(1)

    await act(async () => root?.unmount())
    root = undefined
    mocks.updateAgent.mockClear()
    const off = await mount()
    await clickButton(off, 'Edit')
    await act(async () => off.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click())
    await select(off.querySelectorAll<HTMLSelectElement>('select')[0]!, 'usr_1')
    await clickButton(off, 'Save assistant mode')
    expect(off.querySelector('[role="dialog"]')).toBeTruthy()
    const cancel = [...off.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (b) => b.textContent?.trim() === 'Cancel'
    )
    await act(async () => cancel?.click())
    expect(off.querySelector('[role="dialog"]')).toBeNull()
    expect(mocks.updateAgent).not.toHaveBeenCalled()
  })

  // assistant-mode.md §5.9: patrols run on the agent's own host, so they are marked degraded while the mode is on.
  it('marks patrols as degraded only while assistant mode is on', async () => {
    const on = await mount({ assistantMode: { enabled: true, responsibleUserId: 'usr_1' } })
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
    const host = await mount({ askEveryTime: true, assistantMode: { enabled: true, responsibleUserId: 'usr_1' } })
    expect(host.querySelector('[data-assistant-mode-ask-warning]')?.textContent).toContain('wait for approval')
    expect(host.textContent).toContain('Responsible: Ada')
  })
})
