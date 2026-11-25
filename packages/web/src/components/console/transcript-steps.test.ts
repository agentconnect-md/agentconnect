import { describe, expect, it } from 'vitest'
import type { SessionStep } from '@/lib/data'
import type { SessionMessageDto } from '@/lib/api'
import { fmtStep, msgStepBody } from './transcript-steps'

const ID = '0b6d1d55-5f43-4c8e-9a51-2f0a8f5b1c3d'
const MARKER = `[artifact: ${ID} r2 "Q3 report"]`
const row = (text: string, kind = 'text'): SessionMessageDto => ({ seq: 1, sender: 'agent', ts: '', kind, text })

describe('an artifact marker picks the artifact card', () => {
  it('splits a transcript row into its caption and the pinned revision', () => {
    const step = msgStepBody(row(`Published the report.\n${MARKER}`))
    expect(step.text).toBe('Published the report.')
    expect(step.artifact).toEqual({ artifactId: ID, revision: 2, title: 'Q3 report' })
    expect(step.file).toBeUndefined()
  })

  it('leaves a row without the marker, or with it mid-text, as plain text', () => {
    expect(msgStepBody(row('Just text')).artifact).toBeUndefined()
    const inline = msgStepBody(row(`${MARKER}\nand more`))
    expect(inline.artifact).toBeUndefined()
    expect(inline.text).toBe(`${MARKER}\nand more`)
  })

  it('reads only text rows', () => {
    expect(msgStepBody(row(MARKER, 'reasoning')).artifact).toBeUndefined()
  })

  it('keeps a shared-file row a download chip', () => {
    const step = msgStepBody(row('Here.\n[shared: out/a.csv (text/csv, 12 bytes, sha256:1a2b3c4d5e6f7a8b)]'))
    expect(step.file?.name).toBe('a.csv')
    expect(step.artifact).toBeUndefined()
  })

  it('reads the marker off a live reply step, as webchat and AHP stream it', () => {
    const live: SessionStep = { kind: 'done', text: `Done.\n${MARKER}` } as SessionStep
    const step = fmtStep(live)
    expect(step.text).toBe('Done.')
    expect(step.artifact?.revision).toBe(2)
  })
})
