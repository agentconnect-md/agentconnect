// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"enableIframePageLoading":true,"navigation":{"disableChildFrameNavigation":true}}}
// A frame gets a window but never navigates, so nothing reaches the network; a stub stands in for the shim.

import { MessageChannel as NodeChannel, MessagePort as NodePort } from 'node:worker_threads'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactManifestFile, ArtifactRevisionDto } from '@/lib/artifact'
import { PATH_SYNC_MS, SHIM_READY_MS } from '@/lib/artifact-content/viewer-path'

const bytes = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('@/lib/artifact-download', () => ({ fetchArtifactFile: bytes.fetch }))

import { ArtifactSite } from './ArtifactSite'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const ID = '0b6d1d55-5f43-4c8e-9a51-2f0a8f5b1c3d'
const DOMAIN = 'example-usercontent.net'
const ORIGIN = `https://a${ID.replaceAll('-', '')}r2.${DOMAIN}`
const FILES: Record<string, [string, string]> = {
  'index.html': ['text/html', '<h1>index</h1>'],
  'docs/about.html': ['text/html', '<h1>about</h1>']
}

function revision(): ArtifactRevisionDto {
  const files: ArtifactManifestFile[] = Object.entries(FILES).map(([path, [mediaType, body]]) => ({
    path,
    mediaType,
    sha256: '0'.repeat(64),
    bytes: body.length
  }))
  return {
    artifactId: ID,
    number: 2,
    latestRevision: 2,
    entry: 'index.html',
    entryMediaType: 'text/html',
    fileCount: files.length,
    totalBytes: 0,
    producedBy: { agentId: 'agent-1', name: 'Atlas' },
    producedInSessionId: 'session-1',
    createdAt: '2026-11-25T10:00:00.000Z',
    manifest: { entry: 'index.html', files }
  }
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
let shim: { postMessage: ReturnType<typeof vi.fn> }
const onPath = vi.fn()

async function flush() {
  for (let i = 0; i < 4; i++) await act(async () => await Promise.resolve())
}

async function render(path: string | null = null) {
  await act(async () => {
    root.render(
      <ArtifactSite
        artifactId={ID}
        revision={revision()}
        title="Site"
        domain={DOMAIN}
        path={path}
        onPath={onPath}
        download={<button type="button">Download</button>}
      />
    )
  })
  const frame = container.querySelector('iframe')!
  Object.defineProperty(frame, 'contentWindow', { configurable: true, get: () => shim })
  return frame
}

function fromShim(data: unknown, options: { origin?: string; source?: unknown } = {}) {
  act(() => {
    const event = new MessageEvent('message', { data, origin: options.origin ?? ORIGIN })
    Object.defineProperty(event, 'source', { value: options.source ?? shim })
    window.dispatchEvent(event)
  })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  bytes.fetch.mockReset().mockImplementation(async (_id: string, _rev: number, file: { path: string }) => {
    const found = FILES[file.path]!
    return new Blob([found[1]], { type: found[0] })
  })
  vi.stubGlobal('MessageChannel', NodeChannel)
  shim = { postMessage: vi.fn() }
  onPath.mockReset()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  for (const call of shim.postMessage.mock.calls) for (const port of call[2] ?? []) port.close()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('ArtifactSite', () => {
  it('frames the revision’s shim on its own origin with only scripts and same-origin', async () => {
    const frame = await render()
    expect(frame.getAttribute('src')).toBe(`${ORIGIN}/__ac/shim`)
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin')
    expect(frame.getAttribute('srcdoc')).toBeNull()
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer')
  })

  it('answers ready with a port and the entry, and need-port with a port alone', async () => {
    await render()
    fromShim({ t: 'ready' })
    const [message, target, transfer] = shim.postMessage.mock.calls[0]!
    expect(message).toEqual({ t: 'port', entry: '/index.html' })
    expect(target).toBe(ORIGIN)
    expect(transfer[0]).toBeInstanceOf(NodePort)
    fromShim({ t: 'need-port' })
    expect(shim.postMessage.mock.calls[1]![0]).toEqual({ t: 'port' })
    expect(container.querySelector('[aria-busy]')).toBeNull()
  })

  it('opens the page the console URL names', async () => {
    await render('/docs/about.html?x=1')
    fromShim({ t: 'ready' })
    expect(shim.postMessage.mock.calls[0]![0]).toEqual({ t: 'port', entry: '/docs/about.html?x=1' })
  })

  it('opens the entry for a path the console must not ask for', async () => {
    await render('/__ac/sw.js')
    fromShim({ t: 'ready' })
    expect(shim.postMessage.mock.calls[0]![0]).toEqual({ t: 'port', entry: '/index.html' })
  })

  it.each([
    ['another origin', { origin: 'https://evil.example.test' }],
    ['another window', { source: { postMessage: vi.fn() } }],
    ['a sibling revision', { origin: ORIGIN.replace('r2.', 'r1.') }]
  ])('ignores messages from %s', async (_name, options) => {
    await render()
    fromShim({ t: 'ready' }, options)
    fromShim({ t: 'path', path: '/docs/about.html' }, options)
    vi.advanceTimersByTime(PATH_SYNC_MS)
    expect(shim.postMessage).not.toHaveBeenCalled()
    expect(onPath).not.toHaveBeenCalled()
  })

  it('reports page changes coalesced, drops the param for the entry and ignores reserved paths', async () => {
    await render()
    fromShim({ t: 'ready' })
    fromShim({ t: 'path', path: '/docs/about.html' })
    fromShim({ t: 'path', path: '/app/settings#tab' })
    fromShim({ t: 'path', path: '/__ac/shim' })
    vi.advanceTimersByTime(PATH_SYNC_MS)
    expect(onPath.mock.calls).toEqual([['/app/settings#tab']])
    fromShim({ t: 'path', path: '/index.html' })
    vi.advanceTimersByTime(PATH_SYNC_MS)
    expect(onPath.mock.calls.at(-1)).toEqual([null])
    fromShim({ t: 'ready' })
    expect(shim.postMessage.mock.calls.at(-1)![0]).toEqual({ t: 'port', entry: '/index.html' })
  })

  it('falls back to srcdoc with a notice when the shim has no service worker', async () => {
    await render()
    fromShim({ t: 'unsupported', reason: 'no-service-worker' })
    await flush()
    const frame = container.querySelector('iframe')!
    expect(frame.getAttribute('srcdoc')).toBe('<h1>index</h1>')
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.getAttribute('src')).toBeNull()
    expect(container.querySelector('[data-testid="artifact-site-fallback"]')!.textContent).toContain('Download')
  })

  it('falls back when no ready arrives in time', async () => {
    await render()
    act(() => vi.advanceTimersByTime(SHIM_READY_MS - 1))
    expect(container.querySelector('[data-testid="artifact-site-fallback"]')).toBeNull()
    act(() => vi.advanceTimersByTime(1))
    await flush()
    expect(container.querySelector('iframe')!.getAttribute('srcdoc')).toBe('<h1>index</h1>')
  })

  it('does not fall back once ready', async () => {
    await render()
    fromShim({ t: 'ready' })
    act(() => vi.advanceTimersByTime(SHIM_READY_MS * 2))
    expect(container.querySelector('[data-testid="artifact-site-fallback"]')).toBeNull()
  })
})
