import { describe, expect, it } from 'vitest'
import { ConnectionRegistry } from './registry.js'

describe('ConnectionRegistry approval-state tail (slack-approval-dm.md §7)', () => {
  it('settles immediately when nothing is in flight', async () => {
    const reg = new ConnectionRegistry()
    await expect(reg.approvalMutationsSettled('d1')).resolves.toBeUndefined()
  })

  it('runs mutations in arrival order per daemon and hands each caller its own result', async () => {
    const reg = new ConnectionRegistry()
    const order: string[] = []
    let releaseFirst!: () => void
    const first = new Promise<void>((resolve) => (releaseFirst = resolve))
    const a = reg.runApprovalMutation('d1', async () => {
      await first
      order.push('first')
      return 'a'
    })
    const b = reg.runApprovalMutation('d1', async () => {
      order.push('second')
      return 'b'
    })
    await reg.runApprovalMutation('d2', async () => {
      order.push('other-daemon')
    })
    let settled = false
    const waiter = reg.approvalMutationsSettled('d1').then(() => (settled = true))
    expect(order).toEqual(['other-daemon'])
    expect(settled).toBe(false)
    releaseFirst()
    await expect(a).resolves.toBe('a')
    await expect(b).resolves.toBe('b')
    await waiter
    expect(order).toEqual(['other-daemon', 'first', 'second'])
    // The tail is released once drained, so the next waiter does not wait on history.
    await expect(reg.approvalMutationsSettled('d1')).resolves.toBeUndefined()
  })

  it('a failing mutation rejects only its own caller and never wedges the tail', async () => {
    const reg = new ConnectionRegistry()
    const failed = reg.runApprovalMutation('d1', async () => {
      throw new Error('pool closed')
    })
    let ran = false
    const next = reg.runApprovalMutation('d1', async () => {
      ran = true
    })
    await expect(failed).rejects.toThrow('pool closed')
    await expect(next).resolves.toBeUndefined()
    await expect(reg.approvalMutationsSettled('d1')).resolves.toBeUndefined()
    expect(ran).toBe(true)
  })
})
