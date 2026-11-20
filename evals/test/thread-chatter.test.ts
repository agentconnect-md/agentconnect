import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { TICKETING_THREAD, runThreadChatter } from '../response-choice/thread-chatter.js'

const scratchRoots: string[] = []

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-chatter-artifacts-'))
  scratchRoots.push(root)
  return root
}

afterAll(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true })
})

const chatterLines = TICKETING_THREAD.filter((line) => !line.expectReply).length

describe('thread chatter with scripted hosts', () => {
  it('delivers every untagged line through thread affinity and scores an agent that stays quiet as passing', async () => {
    const result = await runThreadChatter({ artifactDir: join(scratch(), 'tagged'), scriptedPolicy: 'tagged' })

    expect(result.error).toBeUndefined()
    expect(result.status).toBe('passed')
    expect(result.verdict.refereeConsistent).toBe(true)
    expect(result.verdict.metrics).toMatchObject({
      lines: TICKETING_THREAD.length,
      chatterLines,
      unwantedReplies: 0,
      missedReplies: 0
    })
    expect(result.verdict.outcome).toMatchObject({ completed: true })
  })

  it('counts each chatter line an agent answers as an unwanted reply', async () => {
    const result = await runThreadChatter({ artifactDir: join(scratch(), 'always'), scriptedPolicy: 'always' })

    expect(result.status).toBe('passed')
    expect(result.verdict.refereeConsistent).toBe(true)
    expect(result.verdict.metrics).toMatchObject({ unwantedReplies: chatterLines, missedReplies: 0 })
    expect(result.verdict.outcome).toMatchObject({ completed: false })
  })
})
