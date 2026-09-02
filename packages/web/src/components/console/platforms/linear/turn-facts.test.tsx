// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { LinearTurnFacts } from './turn-facts'

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

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
})

describe('LinearTurnFacts', () => {
  it('prints the issue, the team and the delegator, and the description as markdown', async () => {
    const el = await render(
      <LinearTurnFacts
        body={{
          linear: {
            event: 'created',
            issue: { identifier: 'ENG-3', title: 'investigate', url: 'https://linear.app/example/issue/ENG-3/x' },
            team: { key: 'ENG', name: 'Engineering' },
            delegatedBy: 'Dana',
            description: '<issue><description>Read the &lt;README&gt;.</description></issue>',
            comments: [{ userId: 'user-9', body: 'earlier note' }],
            guidance: 'Be terse.',
            truncated: true
          }
        }}
      />
    )
    const text = el.textContent ?? ''
    for (const expected of [
      'ENG-3 · investigate',
      'Engineering (ENG)',
      'Dana',
      'Read the <README>.',
      'earlier note',
      'Be terse.',
      'Context truncated'
    ])
      expect(text).toContain(expected)
    expect(text).not.toContain('<description>')
    expect(el.querySelector('a.lnk')?.getAttribute('href')).toBe('https://linear.app/example/issue/ENG-3/x')
  })

  it('omits what the delivery did not carry, and shows an unshaped context whole', async () => {
    const el = await render(
      <LinearTurnFacts body={{ linear: { issue: { identifier: 'ENG-1' }, description: 'plain words' } }} />
    )
    const text = el.textContent ?? ''
    expect(text).toContain('ENG-1')
    expect(text).toContain('plain words')
    for (const absent of ['Team', 'Delegated by', 'Earlier comments', 'Workspace guidance'])
      expect(text).not.toContain(absent)
    expect(el.querySelector('pre')).not.toBeNull()
  })

  it('prints no Description for an issue whose envelope carries none', async () => {
    const el = await render(
      <LinearTurnFacts
        body={{
          linear: {
            issue: { identifier: 'AC-1', title: 'who are you' },
            team: { name: 'AAA' },
            delegatedBy: 'Dana',
            description: '<issue identifier="AC-1">\n<title>who are you</title>\n<team name="AAA"/>\n</issue>'
          }
        }}
      />
    )
    const text = el.textContent ?? ''
    expect(text).toContain('AC-1 · who are you')
    expect(text).not.toContain('Description')
    expect(text).not.toContain('<issue')
    expect(el.querySelector('pre')).toBeNull()
  })

  it('still prints a description the relay cut before its closing tag', async () => {
    const el = await render(
      <LinearTurnFacts
        body={{
          linear: {
            issue: { identifier: 'ENG-3' },
            description: '<issue identifier="ENG-3">\n<description>The first half of a long',
            truncated: true
          }
        }}
      />
    )
    const text = el.textContent ?? ''
    expect(text).toContain('The first half of a long')
    expect(text).toContain('Context truncated')
    expect(text).not.toContain('<issue')
  })

  it('renders nothing for a body without Linear facts', async () => {
    const el = await render(<LinearTurnFacts body={{}} />)
    expect(el.textContent).toBe('')
  })
})
