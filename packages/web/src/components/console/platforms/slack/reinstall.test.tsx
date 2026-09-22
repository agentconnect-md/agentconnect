// @vitest-environment happy-dom

// The built-in Slack app's reinstall round trip: mint, open, poll the install row, report how it ended.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'

const mocks = vi.hoisted(() => ({
  startSlackPlatformInstall: vi.fn(),
  getSlackPlatformInstall: vi.fn()
}))

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  startSlackPlatformInstall: mocks.startSlackPlatformInstall,
  getSlackPlatformInstall: mocks.getSlackPlatformInstall
}))

import { useSlackBuiltinReinstall, type SlackReinstall, type SlackReinstallCallbacks } from './reinstall'

let host: HTMLDivElement
let root: Root
let flow: SlackReinstall
let open: ReturnType<typeof vi.spyOn>
const callbacks = { onStart: vi.fn(), onFailed: vi.fn(), onInstalled: vi.fn() } satisfies SlackReinstallCallbacks

function Harness() {
  flow = useSlackBuiltinReinstall(callbacks)
  return null
}

async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

async function startReinstall(): Promise<void> {
  await act(async () => root.render(<Harness />))
  await act(async () => flow.start('bot-1'))
  await settle()
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.startSlackPlatformInstall.mockReset()
  mocks.getSlackPlatformInstall.mockReset()
  for (const callback of Object.values(callbacks)) callback.mockReset()
  mocks.startSlackPlatformInstall.mockResolvedValue({ id: 'install-1', installUrl: 'https://slack.example.test/oauth' })
  open = vi.spyOn(window, 'open').mockReturnValue(null)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  open.mockRestore()
})

describe('useSlackBuiltinReinstall', () => {
  it('opens the authorize link, polls the install row and reports the reinstalled bot', async () => {
    mocks.getSlackPlatformInstall.mockResolvedValue({
      id: 'install-1',
      status: 'completed',
      failureReason: null,
      missingScopes: [],
      botId: 'bot-1'
    })
    await startReinstall()

    expect(callbacks.onStart).toHaveBeenCalledWith('bot-1')
    expect(mocks.startSlackPlatformInstall).toHaveBeenCalledWith({ botId: 'bot-1' })
    expect(open).toHaveBeenCalledWith('https://slack.example.test/oauth', '_blank', 'noopener,width=680,height=760')
    expect(mocks.getSlackPlatformInstall).toHaveBeenCalledWith('install-1')
    expect(callbacks.onInstalled).toHaveBeenCalledWith('bot-1')
    expect(callbacks.onFailed).not.toHaveBeenCalled()
    expect(flow.botId).toBeNull()
  })

  it('stays in flight while the row is pending', async () => {
    mocks.getSlackPlatformInstall.mockResolvedValue({
      id: 'install-1',
      status: 'pending',
      failureReason: null,
      missingScopes: [],
      botId: null
    })
    await startReinstall()

    expect(flow.botId).toBe('bot-1')
    // A second start while one is in flight mints nothing.
    await act(async () => flow.start('bot-2'))
    expect(mocks.startSlackPlatformInstall).toHaveBeenCalledTimes(1)
  })

  it('reports a reinstall cancelled in Slack', async () => {
    mocks.getSlackPlatformInstall.mockResolvedValue({
      id: 'install-1',
      status: 'failed',
      failureReason: 'denied',
      missingScopes: [],
      botId: null
    })
    await startReinstall()

    expect(callbacks.onFailed).toHaveBeenCalledWith('bot-1', 'The reinstall was cancelled in Slack.')
    expect(callbacks.onInstalled).not.toHaveBeenCalled()
    expect(flow.botId).toBeNull()
  })

  it('names the scopes a short reinstall still lacks', async () => {
    mocks.getSlackPlatformInstall.mockResolvedValue({
      id: 'install-1',
      status: 'failed',
      failureReason: 'missing_scopes',
      missingScopes: ['channels:history'],
      botId: null
    })
    await startReinstall()

    expect(callbacks.onFailed).toHaveBeenCalledWith('bot-1', expect.stringContaining('Missing: channels:history'))
  })

  it('refuses a reinstall that reauthorized a different bot', async () => {
    mocks.getSlackPlatformInstall.mockResolvedValue({
      id: 'install-1',
      status: 'completed',
      failureReason: null,
      missingScopes: [],
      botId: 'bot-2'
    })
    await startReinstall()

    expect(callbacks.onFailed).toHaveBeenCalledWith('bot-1', 'Slack reauthorized a different bot. Please try again.')
    expect(callbacks.onInstalled).not.toHaveBeenCalled()
  })

  it('reports an expired install row', async () => {
    mocks.getSlackPlatformInstall.mockRejectedValue(new ApiError('Not Found', 404))
    await startReinstall()

    expect(callbacks.onFailed).toHaveBeenCalledWith('bot-1', 'This reinstall link expired. Please try again.')
  })

  it('reports a reinstall that could not start, and opens nothing', async () => {
    mocks.startSlackPlatformInstall.mockRejectedValue(new Error('Slack app is not configured'))
    await startReinstall()

    expect(callbacks.onFailed).toHaveBeenCalledWith('bot-1', 'Slack app is not configured')
    expect(open).not.toHaveBeenCalled()
    expect(mocks.getSlackPlatformInstall).not.toHaveBeenCalled()
    expect(flow.botId).toBeNull()
  })
})
