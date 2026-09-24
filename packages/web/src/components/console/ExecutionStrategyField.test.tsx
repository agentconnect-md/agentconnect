// @vitest-environment happy-dom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { ExecutionStrategyField } from './ExecutionStrategyField'
import { LEGACY_SANDBOX, type StrategyOption } from '@/lib/execution-strategy'

let root: Root | undefined
let container: HTMLDivElement | undefined
let picked: string[] = []

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const KVM = 'microsandbox needs a usable /dev/kvm'
const OPTIONS: StrategyOption[] = [
  { value: 'host', available: true },
  { value: 'srt', available: true },
  { value: 'microsandbox', available: false, reason: KVM },
  { value: 'docker', available: false, refusal: 'notOffered' },
  { value: 'firecracker', available: true }
]

function Harness({ options, disabledReason }: { options: StrategyOption[]; disabledReason?: string }) {
  const [value, setValue] = useState(options[0]!.value)
  return (
    <ExecutionStrategyField
      options={options}
      value={value}
      disabledReason={disabledReason}
      onChange={(next) => {
        picked.push(next)
        setValue(next)
      }}
    />
  )
}

async function mount(options: StrategyOption[] = OPTIONS, disabledReason?: string) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root?.render(<Harness options={options} disabledReason={disabledReason} />))
  return container.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!
}

async function open(trigger: HTMLButtonElement) {
  await act(async () => trigger.click())
  return [...container!.querySelectorAll<HTMLButtonElement>('[role="option"]')]
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  picked = []
})

describe('ExecutionStrategyField', () => {
  it('names every strategy plainly, and an unknown one by its slug', async () => {
    const trigger = await mount()
    expect(trigger.getAttribute('aria-label')).toBe('Execution strategy')
    expect(trigger.textContent).toContain('Host')
    const rows = await open(trigger)
    expect(rows.map((row) => row.textContent)).toEqual([
      'Host',
      'Sandbox',
      'VMunavailable',
      'Dockerunavailable',
      'firecracker'
    ])
  })

  it('puts each strategy’s technology and boundary in its tooltip', async () => {
    const rows = await open(await mount())
    expect(rows.map((row) => row.getAttribute('title'))).toEqual([
      'No isolation boundary: sessions run directly on the machine.',
      'SRT: process isolation with bubblewrap, on Linux.',
      `microsandbox: one microVM per session. Needs KVM.\n${KVM}`,
      'Docker: container isolation.\nNot offered where this agent is placed.',
      null
    ])
  })

  it('shows an unavailable strategy disabled, with its probe’s reason', async () => {
    const rows = await open(await mount())
    expect(rows[2]?.disabled).toBe(true)
    expect(rows[2]?.getAttribute('title')).toContain(KVM)
    expect(rows[3]?.getAttribute('title')).toContain('Not offered where this agent is placed.')
    await act(async () => rows[2]!.click())
    await act(async () => rows[1]!.click())
    expect(picked).toEqual(['srt'])
  })

  it('names the sandbox of a daemon that predates the table, and why host is refused there', async () => {
    const rows = await open(
      await mount([
        { value: LEGACY_SANDBOX, available: true },
        { value: 'host', available: false, refusal: 'sandboxRequired' }
      ])
    )
    expect(rows[0]?.textContent).toBe('Sandbox')
    expect(rows[0]?.getAttribute('title')).toBeNull()
    expect(rows[1]?.getAttribute('title')).toBe(
      'No isolation boundary: sessions run directly on the machine.\nThis daemon requires a sandbox.'
    )
  })

  it('keeps the current value but refuses to open while another change must be saved first', async () => {
    const trigger = await mount(OPTIONS, 'Save the computer change before changing the execution strategy.')
    expect(trigger.disabled).toBe(true)
    expect(trigger.textContent).toContain('Host')
    expect(container!.querySelector('.fld')?.getAttribute('title')).toBe(
      'Save the computer change before changing the execution strategy.'
    )
  })
})
