import { describe, expect, it } from 'vitest'
import { createLifecycleGate } from './lifecycle-gate.js'
import { transferPendingMinimumDays } from './transfer.js'

// The transfer lifecycle gate: a pending rule must exist and keep objects as long as a reused download's link needs.

const rule = (id: string, value: string, days: number, prefix = 'ac/src/') =>
  `<Rule><ID>${id}</ID><Filter><And><Prefix>${prefix}</Prefix><Tag><Key>ac-cache</Key><Value>${value}</Value></Tag></And></Filter><Status>Enabled</Status><Expiration><Days>${days}</Days></Expiration></Rule>`

const xml = (...rules: string[]) => `<LifecycleConfiguration>${rules.join('')}</LifecycleConfiguration>`

function gateOver(read: () => Promise<{ kind: 'none' } | { kind: 'rules'; xml: string }>, minimumPendingDays = 2) {
  const warnings: string[] = []
  const gate = createLifecycleGate({
    objects: { getBucketLifecycle: read },
    prefix: 'ac',
    minimumPendingDays,
    log: { info: () => {}, warn: (m) => warnings.push(m) }
  })
  return { gate, warnings }
}

describe('transferPendingMinimumDays', () => {
  it('covers the one-day reuse window plus the link lifetime and grace', () => {
    expect(transferPendingMinimumDays(60)).toBe(2)
    expect(transferPendingMinimumDays(1800)).toBe(2)
    expect(transferPendingMinimumDays(12 * 3600)).toBe(2)
  })
})

describe('createLifecycleGate', () => {
  it('is present, and enabled, for the design rules', async () => {
    const { gate } = gateOver(async () => ({ kind: 'rules', xml: xml(rule('p', 'pending', 2)) }))
    expect(await gate.check()).toBe('present')
    expect(gate.enabled()).toBe(true)
  })

  it('accepts a longer pending window', async () => {
    const { gate } = gateOver(async () => ({ kind: 'rules', xml: xml(rule('p', 'pending', 30)) }))
    expect(await gate.check()).toBe('present')
  })

  it('disables transfers when no pending rule exists', async () => {
    const { gate, warnings } = gateOver(async () => ({ kind: 'none' }))
    expect(await gate.check()).toBe('missing')
    expect(gate.enabled()).toBe(false)
    expect(warnings[0]).toMatch(/no enabled lifecycle rule expiring ac-cache=pending/)
  })

  it('disables transfers when the pending window is shorter than a live link needs', async () => {
    const { gate, warnings } = gateOver(async () => ({ kind: 'rules', xml: xml(rule('p', 'pending', 1)) }))
    expect(await gate.check()).toBe('short')
    expect(gate.enabled()).toBe(false)
    expect(warnings[0]).toMatch(/after 1 day\(s\), shorter than the 2/)
  })

  it('disables transfers when a narrower rule shortens the transfer objects alone', async () => {
    const { gate } = gateOver(async () => ({
      kind: 'rules',
      xml: xml(rule('p', 'pending', 2), rule('t', 'pending', 1, 'ac/src/org_1/transfer/'))
    }))
    expect(await gate.check()).toBe('short')
  })

  it('leaves transfers on when the configuration cannot be read', async () => {
    const { gate } = gateOver(async () => {
      throw new Error('denied')
    })
    expect(await gate.check()).toBe('unknown')
    expect(gate.enabled()).toBe(true)
  })

  it('warns once per transition into short', async () => {
    const { gate, warnings } = gateOver(async () => ({ kind: 'rules', xml: xml(rule('p', 'pending', 1)) }))
    await gate.check()
    await gate.check()
    expect(warnings).toHaveLength(1)
  })
})
