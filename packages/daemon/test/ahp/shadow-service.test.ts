import { expect, it } from 'vitest'
import { AhpShadowService } from '../../src/ahp/shadow-service.js'
it('keeps only bounded derived sessions and ignores superseded output generations', () => {
  const shadow = new AhpShadowService()
  for (let index = 0; index < 65; index++) {
    const base = { sessionId: String(index), turnId: 'turn', generation: 0, at: index }
    shadow.accept({ ...base, kind: 'started', text: 'hello', origin: 'user' })
    shadow.accept({ ...base, kind: 'finished', outcome: 'complete' })
  }
  expect(shadow.snapshot('0')).toBeUndefined()
  const base = { sessionId: '64', turnId: 'next', generation: 0, at: 66 }
  shadow.accept({ ...base, kind: 'started', text: 'next', origin: 'user' })
  shadow.accept({ ...base, kind: 'text', text: 'discarded' })
  shadow.accept({ ...base, kind: 'discarded', nextGeneration: 1 })
  shadow.accept({ ...base, kind: 'text', text: 'late' })
  shadow.accept({ ...base, generation: 1, kind: 'text', text: 'accepted' })
  expect(JSON.stringify(shadow.snapshot('64'))).not.toMatch(/discarded|late/)
  expect(JSON.stringify(shadow.snapshot('64'))).toContain('accepted')
  shadow.dispose()
  expect(shadow.snapshot('64')).toBeUndefined()
})
