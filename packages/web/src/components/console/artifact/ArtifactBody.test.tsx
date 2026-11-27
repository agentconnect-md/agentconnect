// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"enableIframePageLoading":true,"navigation":{"disableChildFrameNavigation":true}}}

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactManifestFile, ArtifactRevisionDto } from '@/lib/artifact'

const bytes = vi.hoisted(() => ({ fetch: vi.fn() }))

vi.mock('@/lib/artifact-download', () => ({
  fetchArtifactFile: bytes.fetch,
  memberFileUrl: (id: string, revision: number) => `${id}@r${revision}`
}))
vi.mock('next/dynamic', async () => {
  const { default: MarkdownView } = await import('@/components/console/MarkdownView')
  return { default: () => MarkdownView }
})

import { ArtifactBody } from './ArtifactBody'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const ID = '0b6d1d55-5f43-4c8e-9a51-2f0a8f5b1c3d'

function revisionOf(entry: string, files: Record<string, [string, string]>): ArtifactRevisionDto {
  const manifest: ArtifactManifestFile[] = Object.entries(files).map(([path, [mediaType, body]]) => ({
    path,
    mediaType,
    sha256: '0'.repeat(64),
    bytes: body.length
  }))
  const entryFile = manifest.find((f) => f.path === entry)!
  return {
    artifactId: ID,
    number: 1,
    latestRevision: 1,
    entry,
    entryMediaType: entryFile.mediaType,
    fileCount: manifest.length,
    totalBytes: manifest.reduce((sum, f) => sum + f.bytes, 0),
    producedBy: { agentId: 'agent-1', name: 'Atlas' },
    producedInSessionId: 'session-1',
    createdAt: '2026-11-25T10:00:00.000Z',
    manifest: { entry, files: manifest }
  }
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
let objectUrls = 0

async function settle() {
  for (let i = 0; i < 5; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
}

async function renderBody(entry: string, files: Record<string, [string, string]>, contentDomain?: string) {
  bytes.fetch.mockImplementation(async (_fileUrl: unknown, file: { path: string; mediaType: string }) => {
    const found = files[file.path]
    if (!found) throw new Error('no such file')
    return new Blob([found[1]], { type: file.mediaType })
  })
  await act(async () => {
    root.render(
      <ArtifactBody
        artifactId={ID}
        revision={revisionOf(entry, files)}
        title="Report"
        download={<button type="button">Download</button>}
        contentDomain={contentDomain}
      />
    )
  })
  await settle()
}

beforeEach(() => {
  bytes.fetch.mockReset()
  objectUrls = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:test/${++objectUrls}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('ArtifactBody', () => {
  it('runs a page as srcdoc in a frame with only allow-scripts and no injected policy', async () => {
    const html = '<!doctype html><html><body><script>fetch("https://api.example.test")</script>Hi</body></html>'
    await renderBody('index.html', { 'index.html': ['text/html', html] })
    const frame = container.querySelector('iframe')!
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.getAttribute('srcdoc')).toBe(html)
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(frame.getAttribute('src')).toBeNull()
  })

  it('runs a page on its revision’s content-domain origin when one is configured, fetching nothing itself', async () => {
    await renderBody('index.html', { 'index.html': ['text/html', '<h1>Hi</h1>'] }, 'example-usercontent.net')
    const frame = container.querySelector('iframe')!
    expect(frame.getAttribute('src')).toBe(`https://a${ID.replaceAll('-', '')}r1.example-usercontent.net/__ac/shim`)
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin')
    expect(frame.getAttribute('srcdoc')).toBeNull()
    expect(bytes.fetch).not.toHaveBeenCalled()
  })

  it('keeps other types in the console with a content domain configured', async () => {
    await renderBody('chart.png', { 'chart.png': ['image/png', 'png-bytes'] }, 'example-usercontent.net')
    expect(container.querySelector('img')!.getAttribute('src')).toBe('blob:test/1')
    expect(container.querySelector('iframe')).toBeNull()
  })

  it('shows an image from a typed blob URL', async () => {
    await renderBody('chart.png', { 'chart.png': ['image/png', 'png-bytes'] })
    const img = container.querySelector('img')!
    expect(img.getAttribute('src')).toBe('blob:test/1')
    expect(vi.mocked(URL.createObjectURL).mock.calls[0]![0]).toMatchObject({ type: 'image/png' })
  })

  it('shows an SVG from a data URL, which stays inert even opened in its own tab', async () => {
    await renderBody('chart.svg', { 'chart.svg': ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"/>'] })
    expect(container.querySelector('img')!.getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/)
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('embeds a PDF with a download fallback for browsers that embed none', async () => {
    await renderBody('report.pdf', {
      'report.pdf': ['application/pdf', '%PDF-1.7'],
      'report.docx': ['application/zip', 'PK']
    })
    const object = container.querySelector('object')!
    expect(object.getAttribute('type')).toBe('application/pdf')
    expect(object.getAttribute('data')).toBe('blob:test/1')
    expect(object.textContent).toContain('Download')
  })

  it('renders Markdown with local images swapped for blob URLs of the revision’s files', async () => {
    await renderBody('docs/report.md', {
      'docs/report.md': ['text/markdown', '# Q3\n\n![chart](img/chart.png)\n\n![remote](https://example.test/x.png)'],
      'docs/img/chart.png': ['image/png', 'png-bytes']
    })
    expect(container.querySelector('h1')!.textContent).toBe('Q3')
    const [local, remote] = [...container.querySelectorAll('img')]
    expect(local!.getAttribute('src')).toBe('blob:test/1')
    expect(remote!.getAttribute('src')).toBe('https://example.test/x.png')
    expect(bytes.fetch).toHaveBeenCalledWith(`${ID}@r1`, expect.objectContaining({ path: 'docs/img/chart.png' }))
  })

  it('highlights source', async () => {
    await renderBody('data.json', { 'data.json': ['application/json', '{"a": 1}'] })
    const code = container.querySelector('pre.hljs code')!
    expect(code.textContent).toBe('{"a": 1}')
    expect(code.innerHTML).toContain('hljs-')
  })

  it('offers only the name, size and download for a type that does not render', async () => {
    await renderBody('deck.pptx', { 'deck.pptx': ['application/vnd.ms-powerpoint', 'PK'] })
    expect(container.textContent).toContain('deck.pptx')
    expect(container.textContent).toContain('No preview')
    expect(container.querySelector('button')!.textContent).toBe('Download')
    expect(bytes.fetch).not.toHaveBeenCalled()
  })

  it('says so when the bytes cannot be fetched', async () => {
    bytes.fetch.mockRejectedValue(new Error('403'))
    await act(async () => {
      root.render(
        <ArtifactBody
          artifactId={ID}
          revision={revisionOf('index.html', { 'index.html': ['text/html', 'x'] })}
          title="Report"
          download={null}
        />
      )
    })
    await settle()
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('couldn’t be loaded')
  })
})
