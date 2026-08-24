import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseRegistrySearch, searchSkillRegistry } from './skills-registry.js'

const hit = (over: Record<string, unknown> = {}) => ({
  id: 'anthropics/skills/pdf',
  skillId: 'pdf',
  name: 'pdf',
  source: 'anthropics/skills',
  installs: 169905,
  ...over
})

describe('skills.sh registry search', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('normalizes hits into installable source + skill pairs, most-installed first', () => {
    expect(
      parseRegistrySearch({
        skills: [hit({ installs: 10 }), hit({ id: 'openai/skills/pdf', source: 'openai/skills', installs: 900 })]
      })
    ).toEqual([
      { id: 'openai/skills/pdf', name: 'pdf', source: 'openai/skills', installs: 900 },
      { id: 'anthropics/skills/pdf', name: 'pdf', source: 'anthropics/skills', installs: 10 }
    ])
  })

  it('drops rows that could not be installed, including CLI-flag-looking values', () => {
    expect(
      parseRegistrySearch({
        skills: [
          hit({ skillId: '--force', name: '--force' }), // would be read as a `-s` flag
          hit({ source: 'https://evil.example/repo?token=x' }), // not the owner/repo form
          hit({ source: 'anthropics/skills evil' }), // whitespace-split into extra argv
          hit({ source: '../repo' }), // `npx skills add` reads this as a LOCAL path
          hit({ source: './repo' }),
          hit({ source: 'anthropics/skills/pdf' }), // three segments: not owner/repo
          hit({ source: '-a/repo' }), // option-like owner
          hit({ skillId: null, name: null }),
          'not-an-object',
          hit()
        ]
      })
    ).toEqual([{ id: 'anthropics/skills/pdf', name: 'pdf', source: 'anthropics/skills', installs: 169905 }])
  })

  it('collapses duplicate source+skill rows and tolerates a missing install count', () => {
    expect(parseRegistrySearch({ skills: [hit({ installs: undefined }), hit()] })).toEqual([
      { id: 'anthropics/skills/pdf', name: 'pdf', source: 'anthropics/skills', installs: null }
    ])
  })

  it('reads nothing out of a malformed payload', () => {
    expect(parseRegistrySearch({})).toEqual([])
    expect(parseRegistrySearch({ skills: 'nope' })).toEqual([])
    expect(parseRegistrySearch(null)).toEqual([])
  })

  it('queries the index with the owner filter and reports hits', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify({ skills: [hit()] }), { headers: { 'content-type': 'application/json' } })
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await searchSkillRegistry('pdf', { owner: 'anthropics', limit: 5 })

    expect(result).toEqual({
      status: 'ok',
      skills: [{ id: 'anthropics/skills/pdf', name: 'pdf', source: 'anthropics/skills', installs: 169905 }]
    })
    const url = new URL(String(fetchMock.mock.calls[0]![0]))
    expect(url.origin + url.pathname).toBe('https://skills.sh/api/search')
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: 'pdf', limit: '5', owner: 'anthropics' })
  })

  it('degrades to unreachable on a non-200, a throw, or unparseable JSON', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 503 }))
    expect(await searchSkillRegistry('pdf')).toEqual({ status: 'unreachable' })

    vi.stubGlobal('fetch', async () => {
      throw new Error('offline')
    })
    expect(await searchSkillRegistry('pdf')).toEqual({ status: 'unreachable' })

    vi.stubGlobal('fetch', async () => new Response('<html>', { headers: { 'content-type': 'text/html' } }))
    expect(await searchSkillRegistry('pdf')).toEqual({ status: 'unreachable' })
  })
})
