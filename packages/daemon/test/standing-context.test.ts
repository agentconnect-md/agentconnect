import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildStandingContext,
  buildWorkspaceRootsAppend,
  MAX_ON_DEMAND_NAMES
} from '../src/session/turn/standing-context.js'

const BASE = {
  agentName: 'bot-multi',
  agentId: 'bot-multi',
  platform: 'slack',
  channel: 'C123',
  thread: 'T123',
  envSecretNames: [],
  fileSecrets: [],
  needsReplyToParent: false,
  memoryIndex: '',
  usesMeta: false
}

const ROOTS = [
  { path: '/srv/agents/bot-multi/repos/acme/infra/checkout', repoFullName: 'acme/infra', branch: 'trunk' },
  {
    path: '/srv/agents/bot-multi/repos/example-co/shared-library/checkout',
    repoFullName: 'example-co/shared-library',
    branch: 'main'
  }
]

describe('buildWorkspaceRootsAppend', () => {
  it('names each additional directory with its repository and branch', () => {
    expect(buildWorkspaceRootsAppend(ROOTS)).toBe(
      [
        '# Additional repositories',
        'Additional repositories checked out for this session (each at its default branch, for reference ' +
          'only; the working directory is none of them):',
        '- /srv/agents/bot-multi/repos/acme/infra/checkout — acme/infra (trunk)',
        '- /srv/agents/bot-multi/repos/example-co/shared-library/checkout — example-co/shared-library (main)'
      ].join('\n')
    )
  })

  it('says nothing when the session has no secondary root', () => {
    expect(buildWorkspaceRootsAppend([])).toBe('')
    expect(buildWorkspaceRootsAppend(undefined)).toBe('')
  })
})

describe('buildWorkspaceRootsAppend with on-demand repositories (decision 20)', () => {
  const dir = join('/srv', 'agents', 'bot-multi', 'clones', 'a1b2c3')
  const ON_DEMAND = {
    path: dir,
    repositories: [
      { repoFullName: 'example-co/api', cloneUrl: 'https://github.com/example-co/api' },
      {
        repoFullName: 'example-group/sub/example-project',
        cloneUrl: 'https://gitlab.com/example-group/sub/example-project.git'
      }
    ]
  }

  it('names the clone directory, one clone with the host’s own URL, the automatic credentials and the names, after the roots', () => {
    expect(buildWorkspaceRootsAppend(ROOTS, ON_DEMAND)).toBe(
      [
        buildWorkspaceRootsAppend(ROOTS),
        '',
        'Authorized but not checked out: example-co/api, example-group/sub/example-project.',
        `When you need one, clone it into ${dir} as <owner>/<repo>, e.g. ` +
          `\`git clone https://github.com/example-co/api ${join(dir, 'example-co', 'api')}\`.`,
        'Credentials for these repositories are automatic.'
      ].join('\n')
    )
  })

  it('keeps its own heading when nothing is checked out, and a nested GitLab path at two levels', () => {
    const gitlabFirst = { path: dir, repositories: [...ON_DEMAND.repositories].reverse() }

    const block = buildWorkspaceRootsAppend([], gitlabFirst)

    expect(block.split('\n')[0]).toBe('# Additional repositories')
    expect(block).not.toContain('checked out for this session')
    expect(block).toContain(
      `\`git clone https://gitlab.com/example-group/sub/example-project.git ${join(dir, 'example-group', 'example-project')}\``
    )
  })

  it('names at most 100 repositories and counts the rest', () => {
    const repositories = Array.from({ length: 103 }, (_, index) => ({
      repoFullName: `example-org/repo-${String(index).padStart(3, '0')}`,
      cloneUrl: `https://github.com/example-org/repo-${String(index).padStart(3, '0')}`
    }))

    const names = buildWorkspaceRootsAppend(undefined, { path: dir, repositories })
      .split('\n')
      .find((line) => line.startsWith('Authorized but not checked out: '))!

    expect(names).toContain('example-org/repo-099 and 3 more.')
    expect(names).not.toContain('example-org/repo-100')
    expect(names.split(', ')).toHaveLength(MAX_ON_DEMAND_NAMES)
  })

  it('says nothing more when every repository is checked out', () => {
    expect(buildWorkspaceRootsAppend(ROOTS, { path: dir, repositories: [] })).toBe(buildWorkspaceRootsAppend(ROOTS))
    expect(buildWorkspaceRootsAppend(undefined, undefined)).toBe('')
  })
})

describe('buildWorkspaceRootsAppend with installation grants (agent-multi-repo-authorization.md decision 10)', () => {
  const dir = join('/srv', 'agents', 'bot-multi', 'clones', 'a1b2c3')
  const grant = (
    accountLogin: string,
    hostName = 'GitHub',
    cloneUrl = `https://github.com/${accountLogin}/<repo>`
  ) => ({
    hostName,
    accountLogin,
    repoFullName: `${accountLogin}/<repo>`,
    cloneUrl
  })

  it('names the accounts and clones the first one’s placeholder repository when no row is listed', () => {
    expect(
      buildWorkspaceRootsAppend([], {
        path: dir,
        repositories: [],
        installations: [grant('acme'), grant('example-co')]
      })
    ).toBe(
      [
        '# Additional repositories',
        'Any repository of these GitHub accounts is authorized: acme, example-co.',
        `When you need one, clone it into ${dir} as <owner>/<repo>, e.g. ` +
          `\`git clone https://github.com/acme/<repo> ${join(dir, 'acme', '<repo>')}\`.`,
        'Credentials for these repositories are automatic.'
      ].join('\n')
    )
  })

  it('follows the listed rows, whose first row stays the example, one line per host', () => {
    const block = buildWorkspaceRootsAppend(ROOTS, {
      path: dir,
      repositories: [{ repoFullName: 'example-co/api', cloneUrl: 'https://github.com/example-co/api' }],
      installations: [
        grant('acme'),
        grant('example-group', 'GitLab', 'https://git.example.test/example-group/<repo>.git')
      ]
    })

    expect(block.split('\n').slice(-5)).toEqual([
      'Authorized but not checked out: example-co/api.',
      'Any repository of the GitHub account acme is also authorized.',
      'Any repository of the GitLab account example-group is also authorized.',
      `When you need one, clone it into ${dir} as <owner>/<repo>, e.g. ` +
        `\`git clone https://github.com/example-co/api ${join(dir, 'example-co', 'api')}\`.`,
      'Credentials for these repositories are automatic.'
    ])
  })

  it('names at most 100 accounts, in the order given, and counts the rest', () => {
    const installations = Array.from({ length: 102 }, (_, index) =>
      grant(`example-org-${String(index).padStart(3, '0')}`)
    )

    const line = buildWorkspaceRootsAppend(undefined, { path: dir, repositories: [], installations })
      .split('\n')
      .find((entry) => entry.startsWith('Any repository of these GitHub accounts'))!

    expect(line).toMatch(/: example-org-000, example-org-001, /)
    expect(line).toContain('example-org-099 and 2 more.')
    expect(line).not.toContain('example-org-100')
  })
})

describe('buildStandingContext with workspace roots', () => {
  it('re-asserts the roots on resume, right after the agent meta block', () => {
    const context = buildStandingContext({ ...BASE, workspaceRoots: ROOTS })

    expect(context.workspaceRootsAppend).toBe(buildWorkspaceRootsAppend(ROOTS))
    expect(context.resumeSystemContext).toContain(context.workspaceRootsAppend)
    expect(context.resumeSystemContext.indexOf('# Additional repositories')).toBeGreaterThan(
      context.resumeSystemContext.indexOf('# Agent')
    )
  })

  it('leaves the context byte-identical when there is no root to name', () => {
    expect(buildStandingContext({ ...BASE, workspaceRoots: [] })).toEqual(buildStandingContext(BASE))
  })

  it('re-asserts the on-demand block on resume, and leaves an agent with none byte-identical', () => {
    const onDemandClones = {
      path: '/srv/agents/bot-multi/clones/a1b2c3',
      repositories: [{ repoFullName: 'example-co/api', cloneUrl: 'https://github.com/example-co/api' }]
    }
    const context = buildStandingContext({ ...BASE, workspaceRoots: ROOTS, onDemandClones })

    expect(context.workspaceRootsAppend).toBe(buildWorkspaceRootsAppend(ROOTS, onDemandClones))
    expect(context.resumeSystemContext).toContain('Authorized but not checked out: example-co/api.')
    expect(buildStandingContext({ ...BASE, workspaceRoots: ROOTS, onDemandClones: undefined })).toEqual(
      buildStandingContext({ ...BASE, workspaceRoots: ROOTS })
    )
  })
})

describe('buildStandingContext with a platform standing block', () => {
  const BLOCK = '# Linear\n- Issue: ENG-1 (id issue-uuid)\n\nWorking here: the issue is the record.'

  it('seats the block after the roots and re-asserts it on resume', () => {
    const context = buildStandingContext({ ...BASE, workspaceRoots: ROOTS, platformStanding: `${BLOCK}\n` })

    expect(context.platformAppend).toBe(BLOCK)
    expect(context.resumeSystemContext).toContain(BLOCK)
    expect(context.sessionContext).toContain(BLOCK)
    const resume = context.resumeSystemContext
    expect(resume.indexOf('# Linear')).toBeGreaterThan(resume.indexOf('# Additional repositories'))
    expect(resume.indexOf('# Linear')).toBeLessThan(resume.indexOf(context.collabAppend))
  })

  it('leaves the context byte-identical when the delivery carried none', () => {
    expect(buildStandingContext({ ...BASE, platformStanding: '' })).toEqual(buildStandingContext(BASE))
    expect(buildStandingContext({ ...BASE, platformStanding: '  \n' })).toEqual(buildStandingContext(BASE))
  })
})
