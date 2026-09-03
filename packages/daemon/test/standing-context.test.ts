import { describe, expect, it } from 'vitest'
import { buildStandingContext, buildWorkspaceRootsAppend } from '../src/session/turn/standing-context.js'

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
