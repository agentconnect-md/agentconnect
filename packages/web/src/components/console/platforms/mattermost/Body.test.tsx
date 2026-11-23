// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MATTERMOST_PLATFORM } from '@agentconnect.md/protocol'
import { MarkdownText, MessageText } from '@/components/console/MessageText'
import { ApiError } from '@/lib/api'
import type { Agent } from '@/lib/data'
import type { WizardFooterState, WizardHost } from '../contract'
import { channelListSemantics, platformRegistry, platformTextRenderer } from '../registry'
import {
  MattermostWizardBody,
  isValidMattermostServerUrl,
  normalizeMattermostServerUrl,
  resolveMattermostCloudUrl
} from './Body'

const agent = { id: 'agent-a', name: 'deploy-bot' } as unknown as Agent

let host: HTMLDivElement
let root: Root
let footer: WizardFooterState | null

function wizardHost(over: Partial<WizardHost> = {}): WizardHost {
  return {
    createIntegration: vi.fn(async () => undefined),
    relayCapability: { available: false, publicUrl: null },
    mode: 'create',
    selectedBot: null,
    transport: 'socket',
    setTransport: vi.fn(),
    shared: false,
    mockMode: false,
    setFooter: (state) => {
      footer = state
    },
    setIdentityChrome: vi.fn(),
    setRegionLocked: vi.fn(),
    setError: vi.fn(),
    close: vi.fn(),
    invalidate: vi.fn(),
    ...over
  }
}

async function render(over: Partial<WizardHost> = {}): Promise<WizardHost> {
  const state = wizardHost(over)
  await act(async () => root.render(<MattermostWizardBody agent={agent} host={state} />))
  return state
}

/** The input under the field label that reads `label`. */
function field(label: string): HTMLInputElement {
  const fld = [...host.querySelectorAll('.fld')].find((el) => el.querySelector('.fldlbl')?.textContent === label)
  return fld!.querySelector('input')!
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Fills both credentials and submits a create whose answer is `refusal`. */
async function submitRefused(refusal: unknown): Promise<WizardHost> {
  const state = await render({ createIntegration: vi.fn(async () => Promise.reject(refusal)) })
  await type(field('Server URL'), 'https://mm.example.com')
  await type(field('Bot Token'), 'mma1b2c3d4e5f6g7h8i9j0')
  await act(async () => footer?.onSubmit())
  return state
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  footer = null
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('Mattermost serverUrl validation', () => {
  it('allows https, self-hosted intranet http://, loopback, and subpaths while rejecting metadata/link-local/userinfo/query', () => {
    expect(isValidMattermostServerUrl('https://mm.example.com')).toBe(true)
    expect(isValidMattermostServerUrl('http://127.0.0.1:8065/mm/')).toBe(true)
    expect(isValidMattermostServerUrl('http://10.0.12.5:8065')).toBe(true)
    expect(isValidMattermostServerUrl('http://mattermost.internal/team')).toBe(true)
    expect(isValidMattermostServerUrl('http://[::1]:8065')).toBe(true)
    expect(isValidMattermostServerUrl('http://[fe8::1]:8065')).toBe(true)

    expect(isValidMattermostServerUrl('http://169.254.169.254/latest')).toBe(false)
    expect(isValidMattermostServerUrl('http://[::ffff:169.254.169.254]:8065')).toBe(false)
    expect(isValidMattermostServerUrl('http://[::ffff:a9fe:a9fe]:8065')).toBe(false)
    expect(isValidMattermostServerUrl('http://[fe80::1]:8065')).toBe(false)
    expect(isValidMattermostServerUrl('http://[febf::1]:8065')).toBe(false)
    expect(isValidMattermostServerUrl('http://0.0.0.0:8065')).toBe(false)
    expect(isValidMattermostServerUrl('http://0.1.2.3:8065')).toBe(false)
    expect(isValidMattermostServerUrl('http://[::]:8065')).toBe(false)
    expect(isValidMattermostServerUrl('http://[::ffff:0.0.0.0]:8065')).toBe(false)
    expect(isValidMattermostServerUrl('http://[::ffff:0:0]:8065')).toBe(false)
    expect(isValidMattermostServerUrl('http://acme.cloud.mattermost.com')).toBe(false)
    expect(isValidMattermostServerUrl('ftp://mm.example.com')).toBe(false)
    expect(isValidMattermostServerUrl('https://user:pass@mm.example.com')).toBe(false)
    expect(isValidMattermostServerUrl('https://user@mm.example.com')).toBe(false)
    expect(isValidMattermostServerUrl('https://mm.example.com?foo=bar')).toBe(false)
    expect(isValidMattermostServerUrl('https://mm.example.com?')).toBe(false)
    expect(isValidMattermostServerUrl('https://mm.example.com#hash')).toBe(false)
    expect(isValidMattermostServerUrl('https://mm.example.com#')).toBe(false)

    expect(normalizeMattermostServerUrl(' https://mm.example.com/ ')).toBe('https://mm.example.com')
    expect(normalizeMattermostServerUrl('http://10.0.12.5:8065/chat///')).toBe('http://10.0.12.5:8065/chat')
    expect(normalizeMattermostServerUrl('https://mm.example.com/admin_console/integrations/bot_accounts')).toBe(
      'https://mm.example.com'
    )
    expect(normalizeMattermostServerUrl('https://mm.example.com/sub/admin_console/integrations/bot_accounts/')).toBe(
      'https://mm.example.com/sub'
    )
  })

  it('expands Mattermost Cloud workspace slugs and enforces HTTPS in Cloud mode', () => {
    expect(resolveMattermostCloudUrl('acme-team')).toBe('https://acme-team.cloud.mattermost.com')
    expect(resolveMattermostCloudUrl(' Acme ')).toBe('https://acme.cloud.mattermost.com')
    expect(resolveMattermostCloudUrl('acme.cloud.mattermost.com')).toBe('https://acme.cloud.mattermost.com')
    expect(resolveMattermostCloudUrl('acme.cloud.mattermost.com/admin_console/integrations/bot_accounts')).toBe(
      'https://acme.cloud.mattermost.com'
    )
    expect(resolveMattermostCloudUrl('https://acme.cloud.mattermost.com/')).toBe('https://acme.cloud.mattermost.com')
    expect(resolveMattermostCloudUrl('https://mm-cloud.company.com/sub/')).toBe('https://mm-cloud.company.com/sub')
    expect(resolveMattermostCloudUrl('http://acme.cloud.mattermost.com')).toBeNull()
    expect(resolveMattermostCloudUrl('')).toBeNull()
  })
})

describe('MattermostWizardBody', () => {
  it('explains Bot Account Token (recommended), PAT support, and self-hosted http:// URLs, with Server URL and Bot Token inputs', async () => {
    await render()
    expect(host.textContent).toContain('Bot Accounts')
    expect(host.textContent).toContain('Personal Access Token (PAT) is also accepted')
    expect(host.textContent).toContain('intranet and http:// URLs are supported')
    expect([...host.querySelectorAll('.fldlbl')].map((el) => el.textContent)).toEqual(['Server URL', 'Bot Token'])
    expect(field('Bot Token').type).toBe('password')
    expect(footer?.enabled).toBe(false)
  })

  it('connects with the normalized serverUrl and trimmed botToken once valid', async () => {
    const state = await render()
    await type(field('Server URL'), 'ftp://bad.example.com')
    await type(field('Bot Token'), ' mm-token-123 ')
    expect(field('Server URL').className).toContain('border-(--status-error)')
    expect(footer?.enabled).toBe(false)

    await type(field('Server URL'), ' http://10.0.0.8:8065/mattermost/ ')
    expect(field('Server URL').className).not.toContain('border-(--status-error)')
    expect(footer?.enabled).toBe(true)
    await act(async () => footer?.onSubmit())
    expect(state.createIntegration).toHaveBeenCalledWith({
      platform: 'mattermost',
      agentId: 'agent-a',
      mattermost: { serverUrl: 'http://10.0.0.8:8065/mattermost', botToken: 'mm-token-123' }
    })
    expect(state.close).toHaveBeenCalled()
  })

  it.each([
    [
      'MATTERMOST_SERVER_URL_INVALID',
      400,
      'Enter a valid http:// or https:// Mattermost server URL (without username, query, or fragment). Intranet and loopback addresses are supported, while cloud metadata and link-local addresses are blocked.'
    ],
    [
      'MATTERMOST_CREDENTIALS_INVALID',
      400,
      'Mattermost rejected this Bot Token. Check your Server URL and copy a valid Bot Account Token or Personal Access Token (PAT), then connect again.'
    ],
    [
      'MATTERMOST_CHECK_UNAVAILABLE',
      503,
      'AgentConnect couldn’t reach your Mattermost server to verify this bot, so nothing was saved. Check the Server URL and network access, then try again.'
    ]
  ])('explains %s in the console’s own words', async (code, status, expected) => {
    const state = await submitRefused(new ApiError('Control Plane wording', status, code))
    expect(state.setError).toHaveBeenLastCalledWith(expected)
    expect(state.close).not.toHaveBeenCalled()
    expect(footer?.enabled).toBe(true)
  })

  it('points an already installed bot at reusing the existing bot', async () => {
    const coded = await submitRefused(new ApiError('Control Plane wording', 409, 'MATTERMOST_BOT_ALREADY_INSTALLED'))
    expect(coded.setError).toHaveBeenLastCalledWith(
      expect.stringContaining(
        'Disconnect it from any agent using it, then choose “An unused Mattermost bot” to reuse it.'
      )
    )
    expect(coded.setError).toHaveBeenLastCalledWith(expect.stringContaining('“An unused Mattermost bot”'))
  })

  it('shows any other refusal as the Control Plane words it, a different 409 included', async () => {
    const message = 'agent move is in progress; retry the integration change'
    const state = await submitRefused(new ApiError(message, 409))
    expect(state.setError).toHaveBeenLastCalledWith(message)
  })

  it('renders nothing when reusing an existing bot', async () => {
    await render({ mode: 'existing' })
    expect(host.textContent).toBe('')
  })

  it('switches between Self-hosted and Mattermost Cloud, expands workspace slug, and enforces HTTPS in Cloud mode', async () => {
    const state = await render()
    const tabs = [...host.querySelectorAll('[role="tab"]')] as HTMLButtonElement[]
    expect(tabs.map((el) => el.textContent)).toEqual(['Self-hosted', 'Mattermost Cloud'])
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true')

    await act(async () => {
      tabs[1]!.click()
    })
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('true')
    expect(host.textContent).toContain('Mattermost Cloud workspace')
    expect(host.textContent).toContain('no public webhook')
    expect(state.setError).toHaveBeenCalledWith(null)

    await type(field('Workspace or URL'), 'http://acme.cloud.mattermost.com')
    await type(field('Bot Token'), 'mm-cloud-tok')
    expect(field('Workspace or URL').className).toContain('border-(--status-error)')
    expect(footer?.enabled).toBe(false)

    await type(field('Workspace or URL'), 'bytetime-demo')
    expect(field('Workspace or URL').className).not.toContain('border-(--status-error)')
    expect(host.querySelector('[data-testid="mm-cloud-resolved"]')?.textContent).toBe(
      '→ https://bytetime-demo.cloud.mattermost.com'
    )
    expect(footer?.enabled).toBe(true)

    await act(async () => footer?.onSubmit())
    expect(state.createIntegration).toHaveBeenCalledWith({
      platform: 'mattermost',
      agentId: 'agent-a',
      mattermost: {
        serverUrl: 'https://bytetime-demo.cloud.mattermost.com',
        botToken: 'mm-cloud-tok'
      }
    })
  })

  it('submits the wizard on form submit (Enter key)', async () => {
    const state = await render()
    await type(field('Server URL'), 'https://mm.example.com/admin_console/integrations')
    await type(field('Bot Token'), 'mm-token-enter')
    const form = host.querySelector('form')!
    expect(form).not.toBeNull()
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(state.createIntegration).toHaveBeenCalledWith({
      platform: 'mattermost',
      agentId: 'agent-a',
      mattermost: {
        serverUrl: 'https://mm.example.com',
        botToken: 'mm-token-enter'
      }
    })
  })
})

describe('the Mattermost module', () => {
  it('uses explicit MarkdownText renderer instead of Slack mrkdwn fallback', () => {
    const module = platformRegistry.get('mattermost')!
    expect(module.textRenderer).toBe(MarkdownText)
    expect(platformTextRenderer('mattermost')).toBe(MarkdownText)
    const html = renderToStaticMarkup(
      <MessageText text="see <https://example.test|docs> :rocket: **bold**\nnext" platform="mattermost" />
    )
    expect(html).toContain('<strong>bold</strong>')
    expect(html).not.toContain('href="https://example.test"')
    expect(html).toContain(':rocket:')
    expect(html).not.toContain('<br/>')
  })

  it('matches 26-char [a-z0-9] post ids and builds /_redirect/pl/ thread URLs', () => {
    const module = platformRegistry.get('mattermost')!
    const validId = 'a1b2c3d4e5f6g7h8i9j0k1l2m3'
    expect(module.threadShape?.isThreadId(validId)).toBe(true)
    expect(module.threadShape?.isThreadId('A1B2C3D4E5F6G7H8I9J0K1L2M3')).toBe(false)
    expect(module.threadShape?.isThreadId('short')).toBe(false)
    expect(module.threadShape?.isThreadId('1754123456.000200')).toBe(false)
    expect(
      module.threadShape?.threadUrl?.({
        channelId: 'ch123456789012345678901234',
        serverUrl: 'https://mm.example.com/sub/',
        rootId: validId
      })
    ).toBe(`https://mm.example.com/sub/_redirect/pl/${validId}`)
    expect(
      module.threadShape?.threadUrl?.({
        channelId: 'ch123456789012345678901234',
        workspaceId: 'mm-0123456789abcdef',
        rootId: validId
      })
    ).toBeUndefined()
    expect(
      module.threadShape?.threadUrl?.({
        channelId: 'ch123456789012345678901234',
        serverUrl: 'https://user:pass@mm.example.com',
        rootId: validId
      })
    ).toBeUndefined()
  })

  it('exposes channel semantics, feature flag, docs path, and reuse input', () => {
    const semantics = channelListSemantics('mattermost')
    expect(semantics.roomNoun).toBe('channel')
    expect(semantics.roomGlyph).toBe('#')
    expect(semantics.leave).toBe('conversation')
    expect(semantics.triggers).toBeUndefined()
    expect(semantics.sessionModes).toBeUndefined()
    expect(semantics.dmSessionModes).toBeUndefined()

    const module = platformRegistry.get('mattermost')!
    expect(module.platformId).toBe(MATTERMOST_PLATFORM)
    expect(module.requires).toBe('mattermost')
    expect(module.docsPath).toBe('connect-automate/chat-platforms/mattermost')
    expect(
      module.wizard.freeBotFilter({ platform: 'mattermost' } as never, { agentId: 'agent-a', shared: false })
    ).toBe(true)
    expect(module.wizard.buildReuseInput({ id: 'bot-1' } as never, { agentId: 'agent-a', shared: false })).toEqual({
      platform: 'mattermost',
      agentId: 'agent-a',
      botId: 'bot-1'
    })
  })
})
