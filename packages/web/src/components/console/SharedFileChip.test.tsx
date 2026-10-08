// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SharedFile } from '@/lib/shared-file'

const api = vi.hoisted(() => ({ download: vi.fn() }))
const saved = vi.hoisted(() => ({ save: vi.fn() }))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, downloadSessionFile: api.download }
})
vi.mock('@/lib/shared-file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/shared-file')>()
  return { ...actual, saveBlob: saved.save }
})

import { ApiError } from '@/lib/api'
import { SharedFileChip } from './SharedFileChip'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const FILE: SharedFile = {
  path: 'out/chart.png',
  name: 'chart.png',
  mimeType: 'image/png',
  bytes: 48_213,
  sha256: '1a2b3c4d5e6f7a8b'
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

async function render(node: React.ReactNode) {
  await act(async () => {
    root.render(node)
  })
}

async function click() {
  const button = container.querySelector('button')
  expect(button).not.toBeNull()
  await act(async () => {
    button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

beforeEach(() => {
  api.download.mockReset()
  saved.save.mockReset()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('SharedFileChip', () => {
  it('downloads the shared bytes by their recorded digest and saves them under the file’s name', async () => {
    const blob = new Blob(['png'])
    api.download.mockResolvedValue(blob)
    await render(<SharedFileChip file={FILE} agentId="agent-1" sessionId="session-1" />)

    expect(container.textContent).toContain('chart.png')
    expect(container.textContent).toContain('47 KB')
    await click()

    expect(api.download).toHaveBeenCalledWith('agent-1', {
      sessionId: 'session-1',
      path: 'out/chart.png',
      sha256: '1a2b3c4d5e6f7a8b'
    })
    expect(saved.save).toHaveBeenCalledWith(blob, 'chart.png')
  })

  it('says why a download was refused', async () => {
    api.download.mockRejectedValueOnce(new ApiError('changed', 409, 'WORKSPACE_FILE_CHANGED'))
    await render(<SharedFileChip file={FILE} agentId="agent-1" sessionId="session-1" />)
    await click()
    expect(container.textContent).toContain('This file has changed since it was shared')

    api.download.mockRejectedValueOnce(new ApiError('offline', 503))
    await click()
    expect(container.textContent).toContain('Couldn’t download this file')
    expect(saved.save).not.toHaveBeenCalled()
  })

  it('says a file over the download ceiling is too large, as the server decides', async () => {
    api.download.mockRejectedValueOnce(new ApiError('too large', 413, 'WORKSPACE_FILE_TOO_LARGE'))
    await render(<SharedFileChip file={{ ...FILE, bytes: 12 * 1024 * 1024 }} agentId="agent-1" sessionId="session-1" />)
    await click()
    expect(container.textContent).toContain('Too large to download here')
    expect(saved.save).not.toHaveBeenCalled()
  })

  it('offers no download for a path no request could name', async () => {
    await render(<SharedFileChip file={{ ...FILE, path: null }} agentId="agent-1" sessionId="session-1" />)
    expect(container.querySelector('button')).toBeNull()
    expect(container.textContent).toContain('chart.png')
  })
})
