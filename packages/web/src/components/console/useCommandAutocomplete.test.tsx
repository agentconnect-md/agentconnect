// @vitest-environment happy-dom
import { act, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCommandAutocomplete, type CommandMenuEntry } from './useCommandAutocomplete'
import { CommandMenu } from './CommandMenu'
import type { CommandCandidate } from './runtime-command-menu'
import type { ControlCommand } from './composer-control-commands'

const command = (agentId: string, agentName: string, name: string): CommandCandidate => ({
  agentId,
  agentName,
  name,
  description: `${name} description`,
  hint: null
})
const ROSTER = [command('a', 'Alice', 'code-review'), command('b', 'Bob', 'code-review'), command('a', 'Alice', 'tdd')]
const skill = (candidate: CommandCandidate): CommandMenuEntry => ({ kind: 'skill', candidate })

/** Console commands whose runs land in `runs`, the way the session view wires its setters. */
function controlsInto(runs: Array<[string, string | null]>): ControlCommand[] {
  return [
    { name: 'stop', choices: null, run: (value) => runs.push(['stop', value]) },
    {
      name: 'effort',
      choices: [
        { value: 'low', label: 'Low', current: false },
        { value: 'high', label: 'High', current: true }
      ],
      run: (value) => runs.push(['effort', value])
    }
  ]
}

/** A row's label as the menu reads it. */
function label(entry: CommandMenuEntry): string {
  if (entry.kind === 'skill') return entry.candidate.name
  return entry.kind === 'control' ? `control:${entry.control.name}` : `choice:${entry.choice.value}`
}

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = null
  container = null
})

function mountHarness(
  candidates: CommandCandidate[],
  onPicked?: (t: { agentId: string; name: string }) => void,
  controls?: ControlCommand[]
) {
  let api!: ReturnType<typeof useCommandAutocomplete>
  let setDraft!: (v: string) => void
  let getValue!: () => string

  function Harness() {
    const [value, setValue] = useState('')
    const ref = useRef<HTMLTextAreaElement>(null)
    api = useCommandAutocomplete({ ref, value, setValue, candidates, controls, onPicked })
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
    expect(h.api().matches.map(label)).toEqual(['tdd'])
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
    const bobs = h.api().matches.find((e) => e.kind === 'skill' && e.candidate.agentId === 'b')!
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

  it('lists console commands ahead of the skills on either prefix and filters them as typed', () => {
    const h = mountHarness(ROSTER, undefined, controlsInto([]))
    type(h, '!')
    expect(h.api().matches.map(label)).toEqual(['control:stop', 'control:effort', 'code-review', 'code-review', 'tdd'])
    type(h, '/eff')
    expect(h.api().matches.map(label)).toEqual(['control:effort'])
    type(h, '!cancel')
    expect(h.api().matches.map(label)).toEqual(['control:stop'])
  })

  it('runs a console command on pick and keeps it out of the draft', () => {
    const runs: Array<[string, string | null]> = []
    const h = mountHarness(ROSTER, undefined, controlsInto(runs))
    type(h, '!st')
    act(() => h.api().pick(h.api().matches[0]!))
    expect(runs).toEqual([['stop', null]])
    expect(h.getValue()).toBe('')
    expect(h.api().open).toBe(false)
  })

  it('opens a command’s choices as a second level, narrowed by the typed argument', () => {
    const runs: Array<[string, string | null]> = []
    const h = mountHarness(ROSTER, undefined, controlsInto(runs))
    type(h, '/eff')
    act(() => h.api().pick(h.api().matches[0]!))
    expect(h.getValue()).toBe('/effort ')
    expect(h.api().matches.map(label)).toEqual(['choice:low', 'choice:high'])
    expect(runs).toEqual([])

    type(h, '/effort hi')
    expect(h.api().matches.map(label)).toEqual(['choice:high'])
    act(() => h.api().pick(h.api().matches[0]!))
    expect(runs).toEqual([['effort', 'high']])
    expect(h.getValue()).toBe('')
  })

  it('keeps the message below a command typed above it when a choice is picked', () => {
    const runs: Array<[string, string | null]> = []
    const h = mountHarness(ROSTER, undefined, controlsInto(runs))
    const draft = '/eff\nExplain this bug'
    act(() => {
      h.setDraft(draft)
      h.api().sync(draft, 4)
    })
    act(() => h.api().pick(h.api().matches[0]!))
    expect(h.getValue()).toBe('/effort \nExplain this bug')
    act(() => h.api().pick(h.api().matches[1]!))
    expect(runs).toEqual([['effort', 'high']])
    expect(h.getValue()).toBe('Explain this bug')
  })

  it('keeps a skill’s argument free text: only a console command’s argument opens choices', () => {
    const h = mountHarness(ROSTER, undefined, controlsInto([]))
    type(h, '/tdd write tests')
    expect(h.api().open).toBe(false)
    type(h, '/stop now')
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
          options={[
            skill({ ...command('a', 'Alice', 'code-review'), hint: '[pr-number]' }),
            skill(command('b', 'Bob', 'tdd'))
          ]}
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
    expect(text).toContain('code-review')
    expect(text).toContain('tdd')
    expect(text).not.toContain('/code-review')
    // The pane the picker exists for: the ACP-required description, its argument hint, and — in a
    // multi-agent conversation — whose runtime would run it.
    expect(text).toContain('code-review description')
    // Pane-only content: the hint and the owner line render for the ACTIVE row alone.
    expect(text).toContain('[pr-number]')
    expect(text).toContain('Runs on Alice')
    expect(text).not.toContain('Runs on Bob')
  })

  it('names a console command without a prefix and explains what it does', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const [stop, effort] = controlsInto([])
    act(() =>
      root!.render(
        <CommandMenu
          options={[
            { kind: 'control', control: effort! },
            { kind: 'control', control: stop! }
          ]}
          activeIndex={0}
          coords={coords}
          iconOf={() => undefined}
          showOwner={false}
          onHover={() => {}}
          onPick={() => {}}
        />
      )
    )
    const names = [...container.querySelectorAll('[role="option"] .mono')].map((el) => el.textContent)
    expect(names).toEqual(['effort', 'stop'])
    // The pane says only what the highlighted command does: no name heading, no argument hint.
    const pane = container.querySelector('[role="listbox"]')!.nextElementSibling!
    expect(pane.textContent).toBe('List or switch the reasoning effort')
  })

  it('marks the current choice and leaves the skills’ roster gaps off the second level', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const effort = controlsInto([])[1]!
    act(() =>
      root!.render(
        <CommandMenu
          options={effort.choices!.map((choice) => ({ kind: 'choice' as const, control: effort, choice }))}
          activeIndex={0}
          coords={coords}
          iconOf={() => undefined}
          showOwner={false}
          gaps={[{ agentId: 'a', agentName: 'review-bot', reason: 'unreported' }]}
          onHover={() => {}}
          onPick={() => {}}
        />
      )
    )
    const list = container.querySelector('[role="listbox"]')!
    expect(list.getAttribute('aria-label')).toBe('Reasoning effort')
    const rows = [...list.querySelectorAll('[role="option"]')]
    expect(rows.map((row) => row.textContent)).toEqual(['Lowlow', 'Highhigh'])
    expect(rows[1]!.querySelector('svg')).not.toBeNull()
    expect(rows[0]!.querySelector('svg')).toBeNull()
    expect(container.textContent).not.toContain('review-bot')
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
    expect(text).toContain('review-bot hasn’t reported its skills yet')
    expect(text).toContain('refactor-bot is unreachable')
  })

  it('lines the detail pane up with the highlighted row, inside the list’s height', () => {
    // happy-dom has no layout: rows sit 32px apart, the list is `listHeight` tall and the pane 40px.
    let listHeight = 200
    const rowIndex = (el: HTMLElement) => [...(el.parentElement?.children ?? [])].indexOf(el)
    const top = vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'option' ? 4 + rowIndex(this) * 32 : 0
    })
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
      this: HTMLElement
    ) {
      return this.getAttribute('role') === 'listbox' ? listHeight : this.getAttribute('role') === 'option' ? 32 : 40
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const options = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => skill(command('a', 'Alice', name)))
    const render = (activeIndex: number, shown = options, openUpward = true) =>
      act(() =>
        root!.render(
          <CommandMenu
            options={shown}
            activeIndex={activeIndex}
            coords={{ ...coords, openUpward }}
            iconOf={() => undefined}
            showOwner={false}
            onHover={() => {}}
            onPick={() => {}}
          />
        )
      )
    const pane = () => container!.querySelector<HTMLElement>('[role="listbox"] + div')!
    render(2)
    expect(pane().style.top).toBe('68px')
    // The last row would push the pane past the list's bottom edge, so it stops there.
    render(6)
    expect(pane().style.top).toBe('160px')
    // A pane taller than a filtered list grows upward when opening upward, so it never covers the composer.
    listHeight = 20
    render(0, options.slice(0, 1))
    expect(pane().style.top).toBe('-20px')
    render(0, options.slice(0, 1), false)
    expect(pane().style.top).toBe('0px')
    top.mockRestore()
    height.mockRestore()
  })

  it('renders nothing without a caret anchor, so a closed picker leaves no artifact', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() =>
      root!.render(
        <CommandMenu
          options={[skill(command('a', 'Alice', 'tdd'))]}
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
