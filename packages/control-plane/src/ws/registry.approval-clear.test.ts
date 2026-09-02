import { describe, expect, it } from 'vitest'
import { ConnectionRegistry } from './registry.js'

describe('ConnectionRegistry approval-clear chain (slack-approval-dm.md §7)', () => {
  it('settles immediately when nothing is in flight', async () => {
    const reg = new ConnectionRegistry()
    await expect(reg.approvalClearsSettled('d1')).resolves.toBeUndefined()
  })

  it('waiters resolve only after every queued clear ran, in order, per daemon', async () => {
    const reg = new ConnectionRegistry()
    const order: string[] = []
    let releaseFirst!: () => void
    const first = new Promise<void>((resolve) => (releaseFirst = resolve))
    reg.runApprovalClear('d1', async () => {
      await first
      order.push('first')
    })
    reg.runApprovalClear('d1', async () => {
      order.push('second')
    })
    reg.runApprovalClear('d2', async () => {
      order.push('other-daemon')
    })
    let settled = false
    const waiter = reg.approvalClearsSettled('d1').then(() => (settled = true))
    await reg.approvalClearsSettled('d2')
    expect(order).toEqual(['other-daemon'])
    expect(settled).toBe(false)
    releaseFirst()
    await waiter
    expect(order).toEqual(['other-daemon', 'first', 'second'])
    // The chain is released once drained, so the next waiter does not wait on history.
    await expect(reg.approvalClearsSettled('d1')).resolves.toBeUndefined()
  })

  it('a failing clear does not wedge the chain or reject waiters', async () => {
    const reg = new ConnectionRegistry()
    reg.runApprovalClear('d1', async () => {
      throw new Error('pool closed')
    })
    let ran = false
    reg.runApprovalClear('d1', async () => {
      ran = true
    })
    await expect(reg.approvalClearsSettled('d1')).resolves.toBeUndefined()
    expect(ran).toBe(true)
  })
})
