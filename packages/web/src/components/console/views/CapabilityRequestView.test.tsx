// @vitest-environment happy-dom
// A capability request's page: what changes, the agent's reason as plain text, and what a viewer with or without authority may do.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CapabilityRequestDto } from '@/lib/api'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  decline: vi.fn(),
  reopen: vi.fn(),
  forward: vi.fn()
}))

vi.mock('next/link', () => ({
  default: ({ children, className, href }: { children?: ReactNode; className?: string; href?: string }) => (
    <a className={className} href={href}>
      {children}
    </a>
  )
}))
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'req-1' }) }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-1' }, orgPath: (path: string) => `/acme${path}` })
}))
vi.mock('@/components/console/Shell', () => ({ useCrumbSlot: () => ({ register: () => {} }) }))
vi.mock('@/components/console/CapabilityRequestCompletion', () => ({
  CapabilityRequestCompletion: ({ request }: { request: CapabilityRequestDto }) => <div data-completion={request.id} />
}))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  declineCapabilityRequest: mocks.decline,
  reopenCapabilityRequest: mocks.reopen,
  forwardCapabilityRequest: mocks.forward
}))

const { CapabilityRequestBody } = await import('./CapabilityRequestView')

function request(overrides: Partial<CapabilityRequestDto> = {}): CapabilityRequestDto {
  return {
    id: 'req-1',
    orgId: 'org-1',
    agentId: 'agent-1',
    agentName: 'pilot',
    kind: 'agent-settings',
    target: 'model',
    want: { model: 'opus' },
    summary: 'change the model to "opus"',
    reason: 'the bug needs a larger model',
    status: 'open',
    generation: 1,
    createdAt: '2026-10-26T09:00:00.000Z',
    expiresAt: '2026-11-02T09:00:00.000Z',
    settledAt: null,
    settledBy: null,
    outcome: null,
    differs: false,
    note: null,
    origins: [
      {
        sessionId: 'sess-1',
        platform: 'slack',
        placeLabel: '#eng',
        external: false,
        askers: [{ kind: 'member', userId: 'U1', name: 'Ana', platform: 'slack' }],
        nobody: false,
        askedAt: '2026-10-26T09:00:00.000Z',
        wake: 'none',
        wakeReason: null
      }
    ],
    current: { model: 'sonnet' },
    warnings: [],
    viewer: { canComplete: true, canDecline: true, canReopen: true, canForward: true, missing: null, whoCan: [] },
    ...overrides
  }
}

let root: Root | undefined
let host: HTMLDivElement | undefined
const onChange = vi.fn()

async function render(dto: CapabilityRequestDto): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root!.render(<CapabilityRequestBody request={dto} onChange={onChange} />))
  return host
}

const button = (scope: HTMLElement, text: string) =>
  [...scope.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement | undefined

beforeEach(() => {
  mocks.decline.mockReset()
  mocks.reopen.mockReset()
  mocks.forward.mockReset()
  onChange.mockReset()
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  root = undefined
  host = undefined
})

describe('the capability request page', () => {
  it('shows who asked, where, and the setting moving from its current value', async () => {
    const scope = await render(request())
    expect(scope.textContent).toContain('Asked by Ana')
    expect(scope.querySelector('a[href="/acme/sessions/sess-1"]')?.textContent).toBe('#eng')
    const codes = [...scope.querySelectorAll('li code')].map((c) => c.textContent)
    expect(codes).toEqual(['sonnet', 'opus'])
    expect(scope.textContent).toContain('Model:')
  })

  it('renders the reason as plain text, never markup', async () => {
    const scope = await render(request({ reason: '<b>urgent</b> [click](https://example.test)' }))
    const reason = scope.querySelector('[data-reason]')!
    expect(reason.textContent).toBe('<b>urgent</b> [click](https://example.test)')
    expect(reason.querySelector('b')).toBeNull()
    expect(reason.querySelector('a')).toBeNull()
  })

  it('names additions and the server’s warnings', async () => {
    const scope = await render(
      request({
        kind: 'mcp-server',
        want: { server: 'Linear' },
        current: { attached: false, exists: true },
        warnings: ['This server can write to your issue tracker.']
      })
    )
    expect(scope.textContent).toContain('Add MCP server Linear')
    expect(scope.querySelector('[role="note"]')?.textContent).toContain('This server can write to your issue tracker.')
  })

  it('hides an external conversation’s details', async () => {
    const dto = request()
    dto.origins[0] = { ...dto.origins[0]!, external: true }
    const scope = await render(dto)
    expect(scope.textContent).toContain('An external conversation')
    expect(scope.textContent).not.toContain('#eng')
    expect(scope.querySelector('a[href="/acme/sessions/sess-1"]')).toBeNull()
  })

  it('offers the change to a viewer with authority', async () => {
    const scope = await render(request())
    expect(scope.querySelector('[data-completion="req-1"]')).not.toBeNull()
    expect(scope.querySelector('[data-no-authority]')).toBeNull()
  })

  it('tells a viewer without authority what is needed and who has it, and forwards', async () => {
    mocks.forward.mockResolvedValue({ forwarded: 'dm' })
    const scope = await render(
      request({
        viewer: {
          canComplete: false,
          canDecline: false,
          canReopen: false,
          canForward: true,
          missing: 'An editor of this agent',
          whoCan: [{ userId: 'u-ben', name: 'Ben' }]
        }
      })
    )
    expect(scope.querySelector('[data-completion]')).toBeNull()
    expect(scope.textContent).toContain('It needs: An editor of this agent')
    expect(scope.textContent).toContain('People who can: Ben')
    expect(button(scope, 'Decline')).toBeUndefined()
    const select = scope.querySelector('select')!
    await act(async () => {
      select.value = 'u-ben'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => button(scope, 'Forward')!.click())
    expect(mocks.forward).toHaveBeenCalledWith('req-1', 'u-ben', 'org-1')
    expect(scope.textContent).toContain('Forwarded — they got a direct message.')
  })

  it('declines with a note', async () => {
    const declined = request({ status: 'declined', note: 'not now' })
    mocks.decline.mockResolvedValue(declined)
    const scope = await render(request())
    await act(async () => button(scope, 'Decline')!.click())
    const note = scope.querySelector('textarea')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(note, '  We use GitHub issues.  ')
      note.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button(scope, 'Decline request')!.click())
    expect(mocks.decline).toHaveBeenCalledWith('req-1', 'We use GitHub issues.', 'org-1')
    expect(onChange).toHaveBeenCalledWith(declined)
  })

  it('shows a decline with its note, and reopens it', async () => {
    const reopened = request({ generation: 2 })
    mocks.reopen.mockResolvedValue(reopened)
    const scope = await render(
      request({
        status: 'declined',
        settledBy: { kind: 'member', platform: 'slack', name: 'Ben' },
        note: 'Use GitHub.'
      })
    )
    expect(scope.querySelector('[data-status="declined"]')?.textContent).toContain('Declined by Ben')
    expect(scope.querySelector('q')?.textContent).toBe('Use GitHub.')
    expect(scope.querySelector('[data-completion]')).toBeNull()
    await act(async () => button(scope, 'Reopen')!.click())
    expect(mocks.reopen).toHaveBeenCalledWith('req-1', 'org-1')
    expect(onChange).toHaveBeenCalledWith(reopened)
  })

  it('says a completion’s outcome and that the paused agent is told on resume', async () => {
    const dto = request({
      status: 'completed',
      settledBy: { kind: 'console', userId: 'u-ana', name: 'Ana' },
      outcome: 'The model is now opus.'
    })
    dto.origins[0] = { ...dto.origins[0]!, wake: 'pending', wakeReason: 'paused' }
    const scope = await render(dto)
    const state = scope.querySelector('[data-status="completed"]')!
    expect(state.textContent).toContain('Completed by Ana')
    expect(state.textContent).toContain('What changed: The model is now opus.')
    expect(state.textContent).toContain('The agent is paused; it will be told when it resumes.')
    expect(button(scope, 'Decline')).toBeUndefined()
  })
})
