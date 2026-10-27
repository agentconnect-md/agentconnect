import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { canonicalPostId } from '../src/messages/post-id.js'

const uuid = z.string().uuid()

describe('canonical webchat post ids', () => {
  it('keeps a UUID and derives a stable distinct UUID from any other client id', () => {
    const id = '138d6074-3622-4a98-80db-1da58d598ed5'
    expect(canonicalPostId(id)).toBe(id)
    const vscode = 'request_1866be00-76e6-4e68-a870-016d6587d234'
    const derived = canonicalPostId(vscode)
    expect(uuid.safeParse(derived).success).toBe(true)
    expect(canonicalPostId(vscode)).toBe(derived)
    expect(canonicalPostId(canonicalPostId(vscode))).toBe(derived)
    expect(canonicalPostId('request_56267564-3b51-4a0a-8e4a-0f13f489ccef')).not.toBe(derived)
  })
})
