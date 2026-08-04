// @vitest-environment happy-dom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/ui', () => ({ Icon: () => <span data-testid="icon" /> }))

import { SessionAgentFocusMenu, type SessionAgentFocusOption } from './SessionAgentFocusMenu'

let root: Root | undefined
let container: HTMLDivElement | undefined

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

const options: SessionAgentFocusOption[] = [
  { agentId: 'deploy', label: 'deploy-bot', href: '/agents/deploy', avatar: <span>DB</span> },
  { agentId: 'review', label: 'review-bot', href: '/agents/review', avatar: <span>RB</span> }
]

function Harness() {
  const [value, setValue] = useState('deploy')
  return <SessionAgentFocusMenu options={options} value={value} onChange={setValue} />
}

describe('SessionAgentFocusMenu', () => {
  it('switches the focused agent without navigating away', async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root?.render(<Harness />))

    const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!
    expect(trigger.textContent).toContain('deploy-bot+1')

    await act(async () => trigger.click())
    expect(container.querySelector('[role="menu"]')?.textContent).toContain('Focus')

    const review = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find((button) =>
      button.textContent?.includes('review-bot')
    )!
    await act(async () => review.click())

    expect(container.querySelector('[role="menu"]')).toBeNull()
    expect(trigger.textContent).toContain('review-bot+1')
  })
})
