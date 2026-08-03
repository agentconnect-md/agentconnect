// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LocalSkillsDto } from '@/lib/api'

const mocks = vi.hoisted(() => ({ fetchAgentLocalSkills: vi.fn<() => Promise<LocalSkillsDto>>() }))

vi.mock('@/lib/api', () => ({ fetchAgentLocalSkills: mocks.fetchAgentLocalSkills }))
vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ activeOrg: { id: 'org-test' } }) }))

import { LocalSkillsList } from './LocalSkillsList'

let host: HTMLDivElement
let root: Root

async function renderList(): Promise<void> {
  host = document.createElement('div')
  await act(async () => {
    root = createRoot(host)
    root.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <LocalSkillsList agentId="a1" />
      </SWRConfig>
    )
  })
  for (let i = 0; i < 20 && /Loading|animate/i.test(host.innerHTML); i += 1) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

afterEach(() => {
  act(() => root.unmount())
})

describe('LocalSkillsList', () => {
  it('renders each workspace skill with its origin tag', async () => {
    mocks.fetchAgentLocalSkills.mockResolvedValue({
      materialized: true,
      skills: [
        { name: 'deploy', description: 'Ship it', origin: 'dream-accepted', path: '.claude/skills/deploy' },
        { name: 'triage', description: null, origin: 'repo', path: '.claude/skills/triage' }
      ]
    })
    await renderList()
    expect(host.textContent).toContain('deploy')
    expect(host.textContent).toContain('Ship it')
    expect(host.textContent).toContain('Dream') // dream-accepted tag
    expect(host.textContent).toContain('triage')
    expect(host.textContent).toContain('Repo') // repo tag
  })

  it('explains an unprepared workspace instead of showing an empty list', async () => {
    mocks.fetchAgentLocalSkills.mockResolvedValue({ materialized: false, skills: [] })
    await renderList()
    expect(host.textContent).toMatch(/not been prepared/i)
  })

  it('shows an empty-state message when the prepared workspace has no skills', async () => {
    mocks.fetchAgentLocalSkills.mockResolvedValue({ materialized: true, skills: [] })
    await renderList()
    expect(host.textContent).toMatch(/no skills/i)
  })
})
