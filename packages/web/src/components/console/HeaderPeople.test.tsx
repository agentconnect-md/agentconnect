// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { NextIntlClientProvider } from 'next-intl'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import messages from '../../../messages/en.json'
import { HeaderPeople, personSub } from './HeaderPeople'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const agent = (agentId: string, label: string) => ({
  agentId,
  label,
  href: `/agents/${agentId}`,
  avatar: <span>{label[0]}</span>
})

function draw(onFocusChange = vi.fn(), agents = [agent('a1', 'deploy-bot')]) {
  act(() =>
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <HeaderPeople
          agents={agents}
          focusAgentId="a1"
          onFocusChange={onFocusChange}
          agentSub="claude-opus · edge-1"
          people={[
            { id: 'u1', name: 'Dana Reyes', sub: '@dana · Slack', face: <span>DR</span> },
            { id: 'u2', name: 'Sam Lin', face: <span>SL</span> },
            { id: 'u3', name: 'Lee Park', face: <span>LP</span> }
          ]}
          footer={<button type="button">Visible to channel members</button>}
        />
      </NextIntlClientProvider>
    )
  )
  return onFocusChange
}

const trigger = () => container.querySelector<HTMLButtonElement>('[data-header-people]')!
const dialog = () => container.querySelector('[data-header-people-dialog]')

it('stacks the agent and two faces, and opens the agent, its people and who can see it', () => {
  draw()
  expect(trigger().textContent).toBe('dDRSL')
  expect(dialog()).toBeNull()
  act(() => trigger().click())
  expect(dialog()?.getAttribute('role')).toBe('dialog')
  expect(dialog()?.textContent).toContain('deploy-bot')
  expect(dialog()?.textContent).toContain('claude-opus · edge-1')
  expect([...container.querySelectorAll('[data-header-person]')].map((row) => row.textContent)).toEqual([
    'DRDana Reyes@dana · Slack',
    'SLSam Lin',
    'LPLee Park'
  ])
  expect(dialog()?.textContent).toContain('Visible to channel members')
  expect(dialog()?.querySelector('a')?.getAttribute('href')).toBe('/agents/a1')
})

it('switches whose workspace the page reads from a row when the session has several agents', () => {
  const onFocusChange = draw(vi.fn(), [agent('a1', 'deploy-bot'), agent('a2', 'review-bot')])
  act(() => trigger().click())
  expect(container.querySelector('[data-header-people-agent="a1"]')?.getAttribute('aria-pressed')).toBe('true')
  act(() => container.querySelector<HTMLButtonElement>('[data-header-people-agent="a2"]')!.click())
  expect(onFocusChange).toHaveBeenCalledWith('a2')
})

it('closes on Escape and on a click outside', () => {
  draw()
  act(() => trigger().click())
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  })
  expect(dialog()).toBeNull()
  act(() => trigger().click())
  act(() => {
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  })
  expect(dialog()).toBeNull()
})

const hover = (type: 'pointerover' | 'pointerout', pointerType = 'mouse') =>
  act(() => {
    trigger().dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        pointerType,
        relatedTarget: type === 'pointerout' ? document.body : null
      })
    )
  })

it('opens on hover and closes when the mouse leaves, without a native tooltip', () => {
  draw()
  expect(trigger().hasAttribute('title')).toBe(false)
  hover('pointerover')
  expect(dialog()?.textContent).toContain('deploy-bot')
  hover('pointerout')
  expect(dialog()).toBeNull()
})

it('keeps a clicked popover open after the mouse leaves, and a second click closes it', () => {
  draw()
  hover('pointerover')
  act(() => trigger().click())
  hover('pointerout')
  expect(dialog()).not.toBeNull()
  act(() => trigger().click())
  expect(dialog()).toBeNull()
})

it('ignores a touch pointer entering, so a tap alone decides', () => {
  draw()
  hover('pointerover', 'touch')
  expect(dialog()).toBeNull()
})

it('names a person by handle and platform, and by platform alone when the handle is a raw member id', () => {
  expect(personSub('@dana', 'Slack')).toBe('@dana · Slack')
  expect(personSub('U0123ABCD', 'Slack')).toBe('Slack')
  expect(personSub('@you', 'Slack')).toBe('Slack')
})
