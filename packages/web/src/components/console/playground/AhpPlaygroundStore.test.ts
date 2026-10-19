import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@/lib/data'
const { mint } = vi.hoisted(() => ({ mint: vi.fn() }))
vi.mock('@/lib/api', () => ({
  mintWebchatToken: mint,
  mintWebchatConversationToken: mint,
  mintWebchatSessionToken: mint,
  addWebchatConversationAgent: vi.fn(),
  removeWebchatConversationAgent: vi.fn()
}))
const { AhpPlaygroundStore } = await import('./AhpPlaygroundStore')
let store: InstanceType<typeof AhpPlaygroundStore>
const agent = { id: 'a', name: 'Alpha' } as Agent
beforeEach(() => {
  mint.mockReset().mockResolvedValue({ protocol: 'legacy' })
  store = new AhpPlaygroundStore('org', vi.fn())
})
afterEach(async () => {
  await store.close()
})
describe('AHP UI store', () => {
  it('retains a draft and image when AHP bootstrap is unavailable without falling back', async () => {
    const ui = store.getValue(),
      id = ui.openPlayground(agent)
    const image = { name: 'image.webp', mimeType: 'image/webp' as const, data: 'YQ==' }
    ui.setPgInput(id, 'Keep my draft')
    ui.setPgImage(id, image)
    expect(ui.pgSend(id, 'a')).toBe(true)
    await vi.waitFor(() => expect(ui.getPgInput(id)).toBe('Keep my draft'))
    expect(ui.getPgImage(id)).toBe(image)
    expect(ui.getPgSession(id)?.steps.at(-1)?.text).toContain('Your draft has been kept')
    expect(mint).toHaveBeenCalledWith('org', 'a', undefined, 'ahp')
  })
  it('does not clear a draft while its file upload is unfinished', () => {
    const ui = store.getValue(),
      id = ui.openPlayground(agent)
    ui.setPgInput(id, 'Draft')
    ui.setPgFiles(id, () => [{ key: 'file', name: 'file.txt', size: 3, status: 'uploading' }])
    expect(ui.pgSend(id, 'a')).toBe(false)
    expect(ui.getPgInput(id)).toBe('Draft')
    expect(ui.getPgFiles(id)).toHaveLength(1)
  })
  it('refuses to change a continuation target while admission is outstanding', async () => {
    mint.mockImplementation(() => new Promise(() => {}))
    const ui = store.getValue()
    ui.markSessionTarget('ui', 'first')
    ui.pgAttach('ui', 'a', 'conversation')
    ui.pgSend('ui', 'a', 'Pending')
    ui.setPgInput('ui', 'Next draft')
    ui.markSessionTarget('ui', 'second')
    expect(ui.pgSend('ui', 'a')).toBe(false)
    expect(ui.getPgInput('ui')).toBe('Next draft')
    expect(mint).toHaveBeenCalledWith('org', 'first', 'ahp')
  })
})
