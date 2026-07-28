import { describe, it, expect } from 'vitest'
import { serializeBySkillSource, serializeBySkillSourceNames } from './skill-sources.js'

describe('serializeBySkillSourceNames', () => {
  it('two multi-source writers naming the chains in opposite order both complete, mutually excluded', async () => {
    // Unsorted entry would deadlock here: A holds s1 waiting on s2's tail while B
    // holds s2 waiting on s1's. Sorted entry means both join s1 first — strict
    // serialization, no cycle.
    const order: string[] = []
    const critical = (label: string) => async () => {
      order.push(`start:${label}`)
      await new Promise((r) => setTimeout(r, 10))
      order.push(`end:${label}`)
      return label
    }
    const [a, b] = await Promise.all([
      serializeBySkillSourceNames('org-1', ['s1', 's2'], critical('A')),
      serializeBySkillSourceNames('org-1', ['s2', 's1'], critical('B'))
    ])
    expect(a).toBe('A')
    expect(b).toBe('B')
    expect(order).toEqual(['start:A', 'end:A', 'start:B', 'end:B'])
  })

  it('a single-name writer queues behind a held serializeBySkillSource section (the DELETE↔agent-write fence)', async () => {
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const del = serializeBySkillSource('org-1', 's1', async () => {
      order.push('delete:checked')
      await gate // parked mid-critical-section (the reference check just read its snapshot)
      order.push('delete:dropped')
    })
    const write = serializeBySkillSourceNames('org-1', ['s1'], async () => {
      order.push('agent:written')
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual(['delete:checked']) // the write cannot land inside the window
    release()
    await Promise.all([del, write])
    expect(order).toEqual(['delete:checked', 'delete:dropped', 'agent:written'])
  })

  it('chains are org-scoped — the same source name in another org does not serialize', async () => {
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const held = serializeBySkillSource('org-1', 's1', async () => {
      order.push('org1:held')
      await gate
    })
    await serializeBySkillSourceNames('org-2', ['s1'], async () => {
      order.push('org2:ran')
    })
    expect(order).toEqual(['org1:held', 'org2:ran']) // org-2 never waited
    release()
    await held
  })
})
