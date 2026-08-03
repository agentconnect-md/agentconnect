// @vitest-environment happy-dom

/**
 * The audience label and confirmation copy are product promises
 * (docs/product-conventions.md). An agent on native runtime memory has no
 * per-session capture gate, so the dialog must NOT tell that user their
 * conversation stops feeding shared memory.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/marks', () => ({ Spinner: () => <span data-testid="spinner" /> }))
vi.mock('@/components/ui', () => ({
  Icon: () => <span data-testid="icon" />,
  Button: ({ children, ...rest }: { children?: React.ReactNode }) => <button {...rest}>{children}</button>
}))

import { SessionVisibilityControl } from './SessionVisibilityControl'

let root: Root | undefined
let container: HTMLDivElement | undefined

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

async function openTightenDialog(nativeMemory: boolean): Promise<string> {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <SessionVisibilityControl
        sessionId="acp-1"
        visibility="org"
        canChange
        nativeMemory={nativeMemory}
        onChanged={() => {}}
      />
    )
  })
  const everyone = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Everyone')
  expect(everyone?.title).toBe('Visible to everyone who can view the agent')
  expect(container.textContent).not.toContain('Org')
  const privateButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Private'))
  await act(async () => privateButton?.click())
  return document.body.textContent ?? ''
}

describe('SessionVisibilityControl — tighten confirmation', () => {
  it('promises the memory boundary on an ordinary (gated) agent', async () => {
    const text = await openTightenDialog(false)
    expect(text).toContain('stops it from feeding shared agent memory')
    // …and still states the caveat that past distillation is not retracted.
    expect(text).toContain('already learned')
  })

  it('withholds that promise on a native-memory agent and says why', async () => {
    const text = await openTightenDialog(true)
    expect(text).not.toContain('stops it from feeding shared agent memory')
    expect(text).toContain('hides the transcript')
    expect(text).toContain('no per-session control')
  })

  it.each([
    ['feishu', 'Feishu'],
    ['lark', 'Lark']
  ] as const)('labels a settled %s external audience as %s members', async (feishuRegion, brand) => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <SessionVisibilityControl
          sessionId="acp-1"
          visibility="external"
          externalProvider="feishu"
          externalResolution="settled"
          feishuRegion={feishuRegion}
          canChange={false}
          onChanged={() => {}}
        />
      )
    })
    expect(container.textContent).toContain(`${brand} members`)
    expect(container.querySelector('span')?.title).toBe(
      `Visible to current members of the source ${brand} conversation`
    )
  })
})
