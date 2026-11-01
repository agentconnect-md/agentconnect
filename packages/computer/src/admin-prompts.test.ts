import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { AdminPromptHelper } from './admin-prompts.js'

// A stand-in for windows/admin-prompts.cs: what the daemon writes arrives on `requests`, `say` is what the helper prints.
function fakeHelper() {
  const children: Array<{ requests: string[]; say: (message: object) => void; exit: (code: number) => void }> = []
  const spawnHelper = (): ChildProcess => {
    const child = new EventEmitter() as ChildProcess & EventEmitter
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const requests: string[] = []
    stdin.on('data', (chunk: Buffer) => requests.push(...chunk.toString().trim().split('\n')))
    Object.assign(child, { stdin, stdout })
    children.push({
      requests,
      say: (message) => stdout.write(`${JSON.stringify(message)}\n`),
      exit: (code) => child.emit('exit', code, null)
    })
    return child
  }
  return { children, spawnHelper }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

describe('AdminPromptHelper', () => {
  it('reports a prompt the helper read, answers it, and forgets it once gone', async () => {
    const { children, spawnHelper } = fakeHelper()
    const onChange = vi.fn()
    const helper = AdminPromptHelper.start('helper.exe', { onChange, log: () => undefined, spawnHelper })
    const child = children[0]!
    child.say({
      event: 'prompt',
      id: '1',
      kind: 'consent',
      app: 'Windows Command Processor',
      command: '"C:\\Windows\\system32\\cmd.exe"',
      lines: ['Do you want to allow this app to make changes to your device?', 7]
    })
    await tick()
    expect(helper.pending()).toEqual({
      id: '1',
      kind: 'consent',
      app: 'Windows Command Processor',
      command: '"C:\\Windows\\system32\\cmd.exe"',
      lines: ['Do you want to allow this app to make changes to your device?']
    })
    expect(onChange).toHaveBeenCalledTimes(1)
    const answered = helper.answer('1', 'approve')
    await tick()
    expect(child.requests).toEqual(['{"id":"1","answer":"approve"}'])
    child.say({ event: 'answered', id: '1', answer: 'approve', ok: true })
    await expect(answered).resolves.toBeUndefined()
    child.say({ event: 'gone', id: '1' })
    await tick()
    expect(helper.pending()).toBeUndefined()
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it("passes on the helper's refusal, and its problem until it clears", async () => {
    const { children, spawnHelper } = fakeHelper()
    const helper = AdminPromptHelper.start('helper.exe', {
      onChange: () => undefined,
      log: () => undefined,
      spawnHelper
    })
    const child = children[0]!
    child.say({ event: 'prompt', id: '4', kind: 'credentials', lines: [] })
    await tick()
    const answered = helper.answer('4', 'approve')
    await tick()
    child.say({ event: 'answered', id: '4', ok: false, error: 'only a person at the computer can approve it' })
    await expect(answered).rejects.toThrow('only a person')
    child.say({ event: 'problem', message: 'cannot open the input desktop' })
    await tick()
    expect(helper.problem).toBe('cannot open the input desktop')
    await expect(helper.answer('4', 'deny')).rejects.toThrow('cannot open the input desktop')
    child.say({ event: 'problem', message: '' })
    await tick()
    expect(helper.problem).toBeUndefined()
  })

  it('starts the helper again after it exits, and fails what waited on it', async () => {
    const { children, spawnHelper } = fakeHelper()
    const helper = AdminPromptHelper.start('helper.exe', {
      onChange: () => undefined,
      log: () => undefined,
      spawnHelper,
      restartMs: 1
    })
    children[0]!.say({ event: 'prompt', id: '1', kind: 'consent', lines: [] })
    await tick()
    const answered = helper.answer('1', 'deny')
    children[0]!.exit(1)
    await expect(answered).rejects.toThrow('exited (code 1)')
    expect(helper.pending()).toBeUndefined()
    expect(helper.problem).toContain('exited')
    await vi.waitFor(() => expect(children).toHaveLength(2))
    expect(helper.problem).toBeUndefined()
    helper.close()
    children[1]!.exit(0)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(children).toHaveLength(2)
  })
})
