// @vitest-environment happy-dom
import { act, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { useCommandAutocomplete } from './useCommandAutocomplete'
import { CommandMenu } from './CommandMenu'
import type { CommandCandidate } from './runtime-command-menu'

const command = (agentId: string, agentName: string, name: string): CommandCandidate => ({
  agentId,
  agentName,
  name,
  description: `${name} description`,
  hint: null
})
const ROSTER = [command('a', 'Alice', 'code-review'), command('b', 'Bob', 'code-review'), command('a', 'Alice', 'tdd')]

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = null
  container = null
})

function mountHarness(candidates: CommandCandidate[], onPicked?: (t: { agentId: string; name: string }) => void) {
  let api!: ReturnType<typeof useCommandAutocomplete>
  let setDraft!: (v: string) => void
  let getValue!: () => string

  function Harness() {
    const [value, setValue] = useState('')
    const ref = useRef<HTMLTextAreaElement>(null)
    api = useCommandAutocomplete({ ref, value, setValue, candidates, onPicked })
    setDraft = setValue
    getValue = () => value
    return <textarea ref={ref} value={value} readOnly />
  }

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<Harness />))
  return { api: () => api, setDraft: (v: string) => setDraft(v), getValue: () => getValue() }
}

/** Type `text` into the harness the way the composer's onChange does. */
function type(h: ReturnType<typeof mountHarness>, text: string) {
  act(() => {
    h.setDraft(text)
    h.api().sync(text, text.length)
  })
}

describe('useCommandAutocomplete', () => {
  it('opens on a leading slash and narrows as the name is typed', () => {
    const h = mountHarness(ROSTER)
    type(h, '/')
    expect(h.api().open).toBe(true)
    expect(h.api().matches).toHaveLength(3)

    type(h, '/tdd')
    expect(h.api().matches.map((c) => c.name)).toEqual(['tdd'])
  })

  it('stays shut for an ordinary slash in the middle of a sentence', () => {
    const h = mountHarness(ROSTER)
    type(h, 'open src/index.ts')
    expect(h.api().open).toBe(false)
  })

  it('writes the command into the draft and leaves room for an argument', () => {
    const h = mountHarness(ROSTER)
    type(h, '/tdd')
    act(() => h.api().pick(h.api().matches[0]!))
    expect(h.getValue()).toBe('/tdd ')
    expect(h.api().open).toBe(false)
  })

  it('names the owner through onPicked instead of writing a mention into the draft', () => {
    const picks: Array<{ agentId: string; name: string }> = []
    const h = mountHarness(ROSTER, (t) => picks.push(t))
    type(h, '/code')
    // Two participants expose `code-review`; picking Bob's must reach Bob, not the whole roster.
    const bobs = h.api().matches.find((c) => c.agentId === 'b')!
    act(() => h.api().pick(bobs))
    expect(h.getValue()).toBe('/code-review ')
    expect(picks).toEqual([{ agentId: 'b', agentName: 'Bob', name: 'code-review' }])
  })

  it('does not open after a mention — the daemon never translates that draft', () => {
    const h = mountHarness(ROSTER)
    type(h, '@Bob /td')
    expect(h.api().open).toBe(false)
    type(h, '@Bob the log is in /tmp')
    expect(h.api().open).toBe(false)
  })

  it('closes when the draft moves out from under the anchor', () => {
    const h = mountHarness(ROSTER)
    type(h, '/td')
    expect(h.api().open).toBe(true)
    act(() => h.setDraft('')) // a queued send clearing the composer
    expect(h.api().open).toBe(false)
  })
})

describe('CommandMenu', () => {
  const coords = { top: 0, left: 0, height: 18, elHeight: 56, elWidth: 400, openUpward: false }

  it('lists the commands and explains the highlighted one', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() =>
      root!.render(
        <CommandMenu
          options={[{ ...command('a', 'Alice', 'code-review'), hint: '[pr-number]' }, command('b', 'Bob', 'tdd')]}
          activeIndex={0}
          coords={coords}
          iconOf={() => ({ icon: null, runtime: 'claude-acp' })}
          showOwner
          onHover={() => {}}
          onPick={() => {}}
        />
      )
    )
    const text = container.textContent ?? ''
    expect(text).toContain('/code-review')
    expect(text).toContain('/tdd')
    // The pane the picker exists for: the ACP-required description, its argument hint, and — in a
    // multi-agent conversation — whose runtime would run it.
    expect(text).toContain('code-review description')
    // Pane-only content: the hint and the owner line render for the ACTIVE row alone. (Each row
    // also carries its own description now — that is the mobile inline fallback, not a leak.)
    expect(text).toContain('[pr-number]')
    expect(text).toContain('Runs on Alice')
    expect(text).not.toContain('Runs on Bob')
  })

  it('says why a participant contributed nothing instead of vanishing', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() =>
      root!.render(
        <CommandMenu
          options={[]}
          activeIndex={0}
          coords={coords}
          iconOf={() => undefined}
          showOwner
          gaps={[
            { agentId: 'a', agentName: 'review-bot', reason: 'unreported' },
            { agentId: 'b', agentName: 'refactor-bot', reason: 'unavailable' }
          ]}
          onHover={() => {}}
          onPick={() => {}}
        />
      )
    )
    const text = container.textContent ?? ''
    expect(text).toContain('review-bot hasn’t run yet')
    expect(text).toContain('refactor-bot is unreachable')
  })

  it('renders nothing without a caret anchor, so a closed picker leaves no artifact', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() =>
      root!.render(
        <CommandMenu
          options={[command('a', 'Alice', 'tdd')]}
          activeIndex={0}
          coords={null}
          iconOf={() => undefined}
          showOwner={false}
          onHover={() => {}}
          onPick={() => {}}
        />
      )
    )
    expect(container.textContent).toBe('')
  })
})
