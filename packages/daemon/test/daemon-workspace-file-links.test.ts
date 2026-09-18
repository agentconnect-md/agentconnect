import { describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import type { TurnRun } from '../src/daemon/turn-types.js'
import type { WorkspaceFileLinkResolver } from '../src/messages/workspace-file-links.js'

function context(isolation: 'shared' | 'session', offDisk = false) {
  const agent = { id: 'agent-a', workspace: { mode: 'git-repo', path: '/shared/primary' } }
  const session = { key: 'session-key', workspaceIsolation: isolation }
  const sessionOf = vi.fn(async () => session as typeof session | undefined)
  const asked = vi.fn((_scope: { agentId: string; path?: string }) => offDisk)
  // A root off this disk exists on no filesystem here, so canonicalizing it throws.
  const canonicalWorkspacePath = vi.fn((_id: string, path: string) => {
    if (offDisk) throw new Error(`ENOENT: ${path}`)
    return path
  })
  const daemon = Object.assign(Object.create(Daemon.prototype), {
    agents: new Map([[agent.id, agent]]),
    store: { getSession: async () => session, getSessionByOutwardId: sessionOf },
    workspaces: {
      secondaryRoots: () => [{ repoFullName: 'org/docs' }],
      sessionWorktreePath: () => '/isolated/primary',
      consoleSecondaryRoot: () => ({ path: '/shared/docs' }),
      sessionRootDirectory: () => '/isolated/docs',
      consoleWorkspaceRoot: (_agent: unknown, path: string) => path,
      offDisk: asked,
      canonicalWorkspacePath
    },
    sessionLink: () => 'https://console.example.test/org/sessions/outward-a',
    sessionLinkSource: () => undefined
  }) as {
    turnWorkspaceFileLinkResolver(
      run: TurnRun,
      acpSessionId: string,
      outwardSessionId: string
    ): Promise<WorkspaceFileLinkResolver | undefined>
  }
  const run = {
    key: session.key,
    entry: {
      agentId: agent.id,
      selectedHost: {
        host: { sessionCwd: () => `/${isolation === 'session' ? 'isolated' : 'shared'}/primary/packages/app` }
      }
    },
    plan: { platform: 'slack' }
  } as unknown as TurnRun
  return { daemon, run, sessionOf, asked, canonicalWorkspacePath }
}

describe('daemon workspace file link context', () => {
  it.each(['shared', 'session'] as const)(
    'uses the exact runtime cwd and matching %s viewer roots',
    async (isolation) => {
      const { daemon, run, asked, canonicalWorkspacePath } = context(isolation)
      const resolve = await daemon.turnWorkspaceFileLinkResolver(run, 'acp-a', 'outward-a')
      // Each root on this disk is canonicalized, and the placement is asked about that root's own path.
      const base = isolation === 'session' ? '/isolated' : '/shared'
      expect(asked.mock.calls.map(([scope]) => scope)).toEqual([
        { agentId: 'agent-a', path: `${base}/primary` },
        { agentId: 'agent-a', path: `${base}/docs` }
      ])
      expect(canonicalWorkspacePath).toHaveBeenCalledTimes(2)
      const relative = new URL(resolve!('../report.md')!)
      expect(relative.pathname).toBe('/org/sessions/outward-a')
      expect(relative.searchParams.get('agent')).toBe('agent-a')
      expect(relative.searchParams.get('file')).toBe('packages/report.md')
      const secondary = new URL(resolve!(`${base}/docs/digest.md`)!)
      expect(secondary.searchParams.get('repo')).toBe('org/docs')
      expect(secondary.searchParams.get('file')).toBe('digest.md')
      if (isolation === 'session') expect(resolve!('/shared/primary/other-session.md')).toBeUndefined()
    }
  )

  it('takes a root off this disk as it is named, where no path here could canonicalize it', async () => {
    const { daemon, run, canonicalWorkspacePath } = context('shared', true)
    const resolve = await daemon.turnWorkspaceFileLinkResolver(run, 'acp-a', 'outward-a')
    expect(new URL(resolve!('../report.md')!).searchParams.get('file')).toBe('packages/report.md')
    expect(canonicalWorkspacePath).not.toHaveBeenCalled()
  })

  it('does not fall back to shared roots when the isolated session no longer resolves', async () => {
    const { daemon, run, sessionOf } = context('session')
    sessionOf.mockResolvedValue(undefined)
    expect(await daemon.turnWorkspaceFileLinkResolver(run, 'acp-a', 'outward-a')).toBeUndefined()
    expect(sessionOf).toHaveBeenCalledWith('outward-a', 'agent-a')
  })
})
