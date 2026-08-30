import { describe, expect, it } from 'vitest'
import { VmAdmission, VmBudgetExceededError, resolveVmBudget } from '../src/vm/admission.js'

describe('resolveVmBudget', () => {
  // The measured rule: guests panic in PID 1 past roughly 2x host cores in SUMMED vCPUs.
  it('derives the vCPU ceiling from host cores, not from a VM count', () => {
    const budget = resolveVmBudget({ hostCores: 8 })
    expect(budget.maxTotalVcpus).toBe(16)
    expect(budget.cpuPerVm).toBe(1)
    expect(budget.maxConcurrentVms).toBe(16)
  })

  // More guests at 1 vCPU beat fewer at 2 for work that waits on a network.
  it('halves the guest count when each one asks for two vCPUs', () => {
    expect(resolveVmBudget({ hostCores: 8, cpuPerVm: 2 }).maxConcurrentVms).toBe(8)
  })

  it('lets an operator tighten either ceiling', () => {
    const budget = resolveVmBudget({ hostCores: 8, maxTotalVcpus: 4, maxConcurrentVms: 2 })
    expect(budget.maxTotalVcpus).toBe(4)
    expect(budget.maxConcurrentVms).toBe(2)
  })

  it('never admits fewer than one guest, however small the host', () => {
    const budget = resolveVmBudget({ hostCores: 1, cpuPerVm: 4 })
    expect(budget.maxConcurrentVms).toBeGreaterThanOrEqual(1)
    expect(budget.maxTotalVcpus).toBeGreaterThanOrEqual(4)
  })
})

describe('VmAdmission', () => {
  it('admits up to the vCPU sum and then refuses, naming the limit', () => {
    // The count ceiling is lifted so the vCPU sum is unambiguously what refuses the fifth guest.
    const admission = new VmAdmission(resolveVmBudget({ hostCores: 2, cpuPerVm: 1, maxConcurrentVms: 99 }))
    admission.acquire('a')
    admission.acquire('b')
    admission.acquire('c')
    admission.acquire('d')
    expect(admission.totalVcpus).toBe(4)
    try {
      admission.acquire('e')
      expect.unreachable('a fifth guest should not have been admitted')
    } catch (err) {
      expect(err).toBeInstanceOf(VmBudgetExceededError)
      // The message has to explain itself: the alternative an operator sees is init segfaulting.
      expect((err as Error).message).toMatch(/guest vCPUs on 2 host cores/)
      expect((err as Error).message).toMatch(/2x cores/)
    }
  })

  // Only reachable when an operator raised the vCPU ceiling past the count one; under the defaults
  // the two coincide and the vCPU message always speaks first.
  it('refuses on the guest count when that is the tighter ceiling', () => {
    const admission = new VmAdmission(resolveVmBudget({ hostCores: 64, maxConcurrentVms: 1 }))
    admission.acquire('a')
    expect(() => admission.acquire('b')).toThrow(/limit \(maxConcurrentVms\)/)
  })

  // Re-entering a launch for an agent that already holds a slot must not charge it twice.
  it('is idempotent per agent', () => {
    const admission = new VmAdmission(resolveVmBudget({ hostCores: 1, maxTotalVcpus: 1 }))
    admission.acquire('a')
    admission.acquire('a')
    expect(admission.admitted()).toEqual(['a'])
    expect(admission.totalVcpus).toBe(1)
  })

  it('frees the slot when a guest goes, so the next one fits', () => {
    const admission = new VmAdmission(resolveVmBudget({ hostCores: 1, maxTotalVcpus: 1 }))
    admission.acquire('a')
    expect(() => admission.acquire('b')).toThrow(VmBudgetExceededError)
    admission.release('a')
    expect(() => admission.acquire('b')).not.toThrow()
    expect(admission.admitted()).toEqual(['b'])
  })

  it('ignores a release for an agent it never admitted', () => {
    const admission = new VmAdmission(resolveVmBudget({ hostCores: 4 }))
    expect(() => admission.release('never-here')).not.toThrow()
  })
})
