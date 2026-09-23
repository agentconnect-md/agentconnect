import { describe, expect, it } from 'vitest'
import { agentHostKey } from '../src/acp/host-key.js'
import { HostPasses } from '../src/daemon/host-passes.js'

const HOST = agentHostKey('bot-a')
const OTHER = agentHostKey('bot-b')
const CEILING = 10_000

describe('HostPasses', () => {
  it('holds a host while any of its passes runs, and restarts its clock at the last settle', () => {
    const passes = new HostPasses()
    expect(passes.holds(HOST, 0, CEILING)).toBe(false)
    expect(passes.settledAt(HOST)).toBeUndefined()

    const distill = passes.begin(HOST, 100)
    const wand = passes.begin(HOST, 200)
    expect(passes.holds(HOST, 300, CEILING)).toBe(true)
    // Another host's pass holds nothing here.
    expect(passes.holds(OTHER, 300, CEILING)).toBe(false)

    wand(400)
    expect(passes.holds(HOST, 500, CEILING)).toBe(true)
    expect(passes.settledAt(HOST)).toBe(400)

    distill(600)
    expect(passes.holds(HOST, 700, CEILING)).toBe(false)
    expect(passes.settledAt(HOST)).toBe(600)

    // A second release is a no-op: it neither drops another pass's hold nor moves the clock.
    const next = passes.begin(HOST, 800)
    distill(900)
    expect(passes.holds(HOST, 1000, CEILING)).toBe(true)
    expect(passes.settledAt(HOST)).toBe(600)
    next(1100)
    expect(passes.settledAt(HOST)).toBe(1100)
  })

  it('takes a pass older than the ceiling as wedged: it holds nothing, while a younger one still does', () => {
    const passes = new HostPasses()
    passes.begin(HOST, 0)
    expect(passes.holds(HOST, CEILING, CEILING)).toBe(true)
    expect(passes.holds(HOST, CEILING + 1, CEILING)).toBe(false)
    passes.begin(HOST, 5_000)
    expect(passes.holds(HOST, CEILING + 1, CEILING)).toBe(true)
  })
})
