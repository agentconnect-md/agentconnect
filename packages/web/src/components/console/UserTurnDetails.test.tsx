// @vitest-environment happy-dom
// The fold under a delivery bubble: a bare "more", and under it the facts — formatted, never the
// prompt. A code-host body renders through the host's own formatter; a Linear body through the
// module's; a body no formatter claims renders nothing at all.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { UserTurnBody } from '@agentconnect.md/protocol'
import { UserTurnDetails } from './UserTurnDetails'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root | undefined
let host: HTMLDivElement | undefined

async function render(node: React.ReactNode) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(node)
  })
  return host
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
})

const codehost: UserTurnBody = {
  codehost: {
    provider: 'github',
    event: 'pull_request:opened',
    action: 'opened',
    subject: {
      kind: 'pull_request',
      repo: 'acme/infra',
      number: 42,
      title: 'fix relay',
      url: 'https://github.com/acme/infra/pull/42'
    },
    author: { login: 'zfy', association: 'CONTRIBUTOR' },
    revision: { base: 'b'.repeat(40), head: 'a'.repeat(40) },
    draft: false,
    review: 'generation',
    body: '## Why\n\nEvery follow-up was dropped.'
  }
}

describe('UserTurnDetails', () => {
  it('folds a code-host body behind "more" and shows the facts, not the prompt, on demand', async () => {
    const el = await render(<UserTurnDetails body={{ ...codehost, prompt: 'THE PROMPT' }} platform="hook" />)
    const toggle = el.querySelector('button')!
    expect(toggle.textContent).toBe('more')
    expect(el.textContent).not.toContain('zfy')
    await click(toggle)
    expect(toggle.textContent).toBe('less')
    const text = el.textContent ?? ''
    expect(text).toContain('acme/infra · #42')
    expect(text).toContain('zfy · contributor')
    expect(text).toContain('bbbbbbb → aaaaaaa')
    expect(text).toContain('requested for this revision')
    expect(text).toContain('Every follow-up was dropped.')
    expect(text).not.toContain('THE PROMPT')
    expect(text).not.toContain('Draft')
    expect(el.querySelector('a.lnk')?.getAttribute('href')).toBe('https://github.com/acme/infra/pull/42')
    await click(toggle)
    expect(el.textContent).not.toContain('zfy')
  })

  it('renders the Linear module’s formatter for a Linear row', async () => {
    const body: UserTurnBody = {
      linear: {
        issue: { identifier: 'ENG-3', title: 'investigate', url: 'https://linear.app/example/issue/ENG-3/investigate' },
        team: { key: 'ENG', name: 'Engineering' },
        delegatedBy: 'Fuyao Zhao',
        description:
          '<issue identifier="ENG-3"><title>investigate</title><description>Look at **the repo**.</description></issue>'
      }
    }
    const el = await render(<UserTurnDetails body={body} platform="linear" />)
    await click(el.querySelector('button')!)
    const text = el.textContent ?? ''
    expect(text).toContain('ENG-3 · investigate')
    expect(text).toContain('Engineering (ENG)')
    expect(text).toContain('Fuyao Zhao')
    expect(text).toContain('Look at the repo.')
    expect(text).not.toContain('<description>')
  })

  it('renders nothing when no formatter claims the body', async () => {
    const el = await render(<UserTurnDetails body={{ linear: { issue: { identifier: 'ENG-1' } } }} platform="slack" />)
    expect(el.querySelector('[data-turn-details]')).toBeNull()
  })
})
