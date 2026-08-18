/** A promise-chain mutex: every acquirer queues behind the previous holder's release. */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve()

  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => (release = resolve))
    const waitFor = this.tail
    this.tail = this.tail.then(() => held)
    await waitFor
    try {
      return await fn()
    } finally {
      release()
    }
  }
}
