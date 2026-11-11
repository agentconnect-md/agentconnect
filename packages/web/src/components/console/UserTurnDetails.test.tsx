// @vitest-environment happy-dom
// The fold under a delivery bubble: a bare "more", and under it the facts — formatted, never the
// prompt. A code-host body renders through the host's own formatter; a Linear body through the
// module's; a body no formatter claims renders nothing at all.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { UserTurnBody } from '@agentconnect.md/protocol'
import { SessionMessageCaption, UserTurnDetails } from './UserTurnDetails'

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

  it('names an Azure DevOps pull request `{organization}/{project}/{repository}!{id}` and links its page (§11.8)', async () => {
    const azure: UserTurnBody = {
      codehost: {
        provider: 'azure-devops',
        event: 'merge_request:opened',
        subject: { kind: 'pull_request', repo: 'example-org/Example Project/example-repo', number: 7 }
      }
    }
    const el = await render(<UserTurnDetails body={azure} platform="hook" />)
    await click(el.querySelector('button')!)
    const link = el.querySelector('a.lnk')!
    expect(link.textContent).toBe('example-org/Example Project/example-repo!7')
    expect(link.getAttribute('href')).toBe(
      'https://dev.azure.com/example-org/Example%20Project/_git/example-repo/pullrequest/7'
    )
  })

  it('captions a session message by its sender and folds its facts and the agent’s guidance', async () => {
    const sessionMessage: NonNullable<UserTurnBody['sessionMessage']> = {
      messageId: 'msg-1',
      kind: 'reply',
      source: { agentId: 'agent-b', label: 'reviewer', sessionId: 'sid-b' },
      inReplyTo: 'msg-0',
      notes: ['To give it more work, call messageTask.']
    }
    const caption = await render(<SessionMessageCaption facts={sessionMessage} />)
    expect(caption.textContent).toBe('Reply from reviewer')
    await act(async () => root?.unmount())
    host?.remove()
    // A report or an instruction has no caption, and neither does a sender known only by its id.
    for (const facts of [
      { ...sessionMessage, kind: 'report' as const },
      { ...sessionMessage, kind: 'taskInput' as const },
      { ...sessionMessage, source: { agentId: 'agent-b' } }
    ]) {
      const none = await render(<SessionMessageCaption facts={facts} />)
      expect(none.textContent).toBe('')
      await act(async () => root?.unmount())
      host?.remove()
    }

    const el = await render(<UserTurnDetails body={{ sessionMessage, prompt: 'THE PROMPT' }} platform="webchat" />)
    const toggle = el.querySelector('button')!
    expect(el.textContent).not.toContain('messageTask')
    await click(toggle)
    const text = el.textContent ?? ''
    expect(text).toContain('reviewer · agent-b')
    expect(text).toContain('sid-b')
    expect(text).toContain('msg-0')
    expect(text).toContain('Guidance the agent received')
    expect(text).toContain('To give it more work, call messageTask.')
    expect(text).not.toContain('THE PROMPT')
  })

  // auto-session-mode.md §6.9.5: a report can run to pages, so its text folds and "more" sits right under its first lines.
  it('folds a session message’s text with its facts, and leaves any other bubble’s text whole', async () => {
    const sessionMessage: NonNullable<UserTurnBody['sessionMessage']> = {
      messageId: 'msg-2',
      kind: 'report',
      source: { agentId: 'agent-a', sessionId: 'sid-a' }
    }
    const heights = {
      scrollHeight: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight'),
      clientHeight: Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight')
    }
    Object.defineProperty(Element.prototype, 'scrollHeight', { configurable: true, get: () => 900 })
    Object.defineProperty(Element.prototype, 'clientHeight', { configurable: true, get: () => 132 })
    try {
      const el = await render(
        <UserTurnDetails body={{ sessionMessage }} platform="slack">
          <p>A long report.</p>
        </UserTurnDetails>
      )
      const folded = () => el.querySelector('[data-folded-text]')
      expect(folded()?.getAttribute('data-folded-text')).toBe('cut')
      expect(folded()?.textContent).toBe('A long report.')
      // The toggle follows the text directly: nothing sits between the first lines and "more".
      expect(folded()?.nextElementSibling?.querySelector('button')?.textContent).toBe('more')
      await click(el.querySelector('button')!)
      expect(folded()).toBeNull()
      expect(el.textContent).toContain('A long report.')
      await act(async () => root?.unmount())
      host?.remove()

      const other = await render(
        <UserTurnDetails body={codehost} platform="hook">
          <p>A pull request opened.</p>
        </UserTurnDetails>
      )
      expect(other.querySelector('[data-folded-text]')).toBeNull()
      expect(other.textContent).toContain('A pull request opened.')
    } finally {
      for (const [name, descriptor] of Object.entries(heights))
        if (descriptor) Object.defineProperty(Element.prototype, name, descriptor)
    }
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
