// @vitest-environment happy-dom

// Usages link where the console has a page for them and count the ones the viewer cannot see.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { DecisionUsageList } from './DecisionUsageList'

let root: Root | undefined
let container: HTMLDivElement | undefined

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

describe('DecisionUsageList', () => {
  it('links usages with a destination, prints the rest, and counts hidden ones', async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <DecisionUsageList
          usages={[
            { kind: 'gate', id: 'int-1:C1', label: '#general · Support', integrationId: 'int-1', channelId: 'C1' },
            { kind: 'shared_bot_routing', id: 'bot', label: 'Support bot' }
          ]}
          hiddenCount={2}
          hrefFor={(usage) => (usage.kind === 'gate' ? '/agents/agent-1' : null)}
        />
      )
    })
    const anchors = [...container.querySelectorAll('a')]
    expect(anchors.map((node) => [node.textContent, node.getAttribute('href')])).toEqual([
      ['#general · Support', '/agents/agent-1']
    ])
    expect([...container.querySelectorAll('span')].some((node) => node.textContent === 'Support bot')).toBe(true)
    expect(container.textContent).toContain('channel gate')
    expect(container.textContent).toContain('2 more you cannot see')
  })
})
