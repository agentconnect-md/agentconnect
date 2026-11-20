import { describe, expect, it } from 'vitest'
import { fromMarkdown } from 'mdast-util-from-markdown'
import type { Nodes } from 'mdast'
import { flattenUnsafeLinks } from '../src/messages/agent-links.js'
import { createWorkspaceFileLinkResolver } from '../src/messages/workspace-file-links.js'

const resolveFileLink = createWorkspaceFileLinkResolver({
  sessionUrl: 'https://console.example.test/acme/sessions/session-1?source=slack',
  agentId: 'agent-1',
  cwd: '/srv/agent/sessions/one/workspace/packages/app',
  roots: [
    { path: '/srv/agent/sessions/one/workspace' },
    { path: '/srv/agent/sessions/one/repos/acme/tools', repo: 'acme/tools' }
  ]
})

function links(text: string): string[] {
  const urls: string[] = []
  const visit = (node: Nodes): void => {
    if (node.type === 'link') urls.push(node.url)
    if ('children' in node) node.children.forEach(visit)
  }
  visit(fromMarkdown(text))
  return urls
}

describe('workspace file links', () => {
  it.each([
    ['/srv/agent/sessions/one/workspace/docs/report.md', 'docs/report.md'],
    ['../../docs/report.md', 'docs/report.md'],
    ['./notes.md', 'packages/app/notes.md'],
    ['file:///srv/agent/sessions/one/workspace/docs/a%20b.md', 'docs/a b.md'],
    ['/srv/agent/sessions/one/workspace/docs/a%23b%3F.md', 'docs/a#b?.md'],
    ['/srv/agent/sessions/one/workspace/docs/100%.md', 'docs/100%.md'],
    ['/srv/agent/sessions/one/workspace/docs/report.md:12:3', 'docs/report.md'],
    ['/srv/agent/sessions/one/workspace/docs/report.md#L12-L20', 'docs/report.md']
  ])('opens %s from the exact session and runtime working directory', (target, file) => {
    const url = new URL(resolveFileLink(target)!)
    expect(url.pathname).toBe('/acme/sessions/session-1')
    expect(Object.fromEntries(url.searchParams)).toEqual({ source: 'slack', view: 'flat', agent: 'agent-1', file })
    expect(url.href).not.toContain('/srv/')
  })

  it('routes an authorized secondary repository through the same session', () => {
    const url = new URL(resolveFileLink('/srv/agent/sessions/one/repos/acme/tools/README.md')!)
    expect(url.searchParams.get('repo')).toBe('acme/tools')
    expect(url.searchParams.get('file')).toBe('README.md')
    expect(url.pathname).toBe('/acme/sessions/session-1')
  })

  it.each([
    '/etc/passwd',
    '/srv/agent/sessions/two/workspace/report.md',
    '/srv/agent/sessions/one/workspace-extra/report.md',
    '../../../private.md',
    '/srv/agent/sessions/one/workspace/.git/config',
    '/srv/agent/sessions/one/workspace/dir%5C.git%5Cconfig',
    '/srv/agent/sessions/one/workspace/%2e%2e/private.md',
    '/srv/agent/sessions/one/workspace/bad%00.md',
    'file://remote.example.test/srv/agent/sessions/one/workspace/report.md',
    'https://example.test/report.md',
    'javascript:alert(1)',
    '#heading',
    '?file=report.md'
  ])('does not map an out-of-scope or non-file target: %s', (target) => {
    expect(resolveFileLink(target)).toBeUndefined()
  })

  it('handles Windows paths independently of the daemon test host', () => {
    const resolve = createWorkspaceFileLinkResolver({
      sessionUrl: 'https://console.example.test/acme/sessions/windows',
      agentId: 'agent-1',
      cwd: 'C:\\agent\\workspace\\src',
      roots: [{ path: 'C:\\agent\\workspace' }]
    })
    for (const target of ['C:\\agent\\workspace\\docs\\report.md', 'file:///C:/agent/workspace/docs/report.md']) {
      expect(new URL(resolve(target)!).searchParams.get('file')).toBe('docs/report.md')
    }
    expect(resolve('D:\\agent\\workspace\\report.md')).toBeUndefined()
    expect(resolve('C:\\agent\\workspace\\.GIT\\config')).toBeUndefined()
  })

  it('keeps file names with URL and Markdown punctuation inside a single target', () => {
    const target = '/srv/agent/sessions/one/workspace/a%20(b)%26c%23d.md'
    const rendered = flattenUnsafeLinks(`[report](<${target}>)`, { resolveFileLink })
    const targets = links(rendered)
    expect(targets).toHaveLength(1)
    expect(new URL(targets[0]!).searchParams.get('file')).toBe('a (b)&c#d.md')
  })

  it('resolves inline and all reference forms while removing host definitions', () => {
    const raw = '[inline](../../report.md), [named][r], [r][], [r].\n\n[r]: /srv/agent/sessions/one/workspace/report.md'
    const rendered = flattenUnsafeLinks(raw, { resolveFileLink })
    expect(links(rendered)).toHaveLength(4)
    expect(new Set(links(rendered)).size).toBe(1)
    expect(rendered).not.toContain('/srv/')
    expect(flattenUnsafeLinks(rendered, { resolveFileLink })).toBe(rendered)
  })

  it('opens workspace images in the viewer without nesting links inside another link', () => {
    const image = flattenUnsafeLinks('![plot](../../plot.png)', { resolveFileLink })
    expect(new URL(links(image)[0]!).searchParams.get('file')).toBe('plot.png')
    const nested = flattenUnsafeLinks('[![plot](../../plot.png)](../../report.md)', { resolveFileLink })
    expect(links(nested)).toHaveLength(1)
    expect(new URL(links(nested)[0]!).searchParams.get('file')).toBe('report.md')
  })

  it('keeps repository-relative code-host links and rewrites absolute workspace files', () => {
    const rendered = flattenUnsafeLinks(
      '[repo](docs/report.md), [local](/srv/agent/sessions/one/workspace/new.md), [outside](/tmp/private.md)',
      { resolvesRelativeTargets: true, resolveFileLink }
    )
    expect(links(rendered)[0]).toBe('docs/report.md')
    expect(new URL(links(rendered)[1]!).searchParams.get('file')).toBe('new.md')
    expect(rendered).toContain('outside (`private.md`)')
    expect(rendered).not.toContain('/tmp/')
  })

  // inbound-file-attachments.md §2.4: session files link to their area and never reach a conversation as host paths.
  describe('session files', () => {
    const areas = [
      { area: 'uploads' as const, paths: ['/srv/agent/files/session-one/uploads'] },
      {
        area: 'outputs' as const,
        paths: ['/srv/agent/files/session-one/outputs', '/real/agent/files/session-one/outputs']
      }
    ]
    const resolve = createWorkspaceFileLinkResolver({
      sessionUrl: 'https://console.example.test/acme/sessions/session-1',
      agentId: 'agent-1',
      cwd: '/srv/agent/workspace',
      roots: [{ path: '/srv/agent/workspace' }],
      areas
    })

    it.each([
      ['files:outputs/report.pdf', 'outputs', 'report.pdf'],
      ['/real/agent/files/session-one/outputs/charts/a.png', 'outputs', 'charts/a.png'],
      ['/srv/agent/files/session-one/uploads/spec.pdf', 'uploads', 'spec.pdf']
    ])('opens %s in its area', (target, root, file) => {
      const url = new URL(resolve(target)!)
      expect(Object.fromEntries(url.searchParams)).toEqual({ view: 'flat', agent: 'agent-1', file, root })
    })

    it('refuses a files: name that climbs out of its area', () => {
      expect(resolve('files:outputs/../secret')).toBeUndefined()
      expect(resolve('files:home/.codex/auth.json')).toBeUndefined()
    })

    it('rewrites an area path in plain reply text to its files: name', () => {
      const text =
        'Saved to /real/agent/files/session-one/outputs/report.pdf and `/srv/agent/files/session-one/uploads/a b`.'
      expect(flattenUnsafeLinks(text, { resolveFileLink: resolve })).toBe(
        'Saved to files:outputs/report.pdf and `files:uploads/a b`.'
      )
      expect(flattenUnsafeLinks('/srv/agent/workspace/x.md stays', { resolveFileLink: resolve })).toBe(
        '/srv/agent/workspace/x.md stays'
      )
    })
  })
})
