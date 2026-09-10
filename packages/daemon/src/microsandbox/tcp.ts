import { Duplex } from 'node:stream'
import { z } from 'zod'

const Envelope = z.object({ v: z.literal(7), t: z.string(), p: z.instanceof(Uint8Array) })
const Data = z.object({ data: z.instanceof(Uint8Array) })
const Failure = z.object({ error: z.string() })

// Use agentd's TCP stream, also used by its SSH forwarding, without publishing a host port.
export async function openGuestTcp(
  sdk: Pick<typeof import('microsandbox'), 'AgentClient'>,
  name: string,
  port: number
): Promise<Duplex> {
  const { encode, decode } = await import('cborg')
  const message = (type: string, payload: unknown) =>
    Buffer.from(encode({ v: 7, t: `core.tcp.${type}`, p: encode(payload) }))
  const client = await sdk.AgentClient.connectSandbox(name)
  const timer = setTimeout(() => void client.close().catch(() => {}), 10_000)
  try {
    const stream = await client.stream(2, message('connect', { host: '127.0.0.1', port }))
    const iterator = stream[Symbol.asyncIterator]()
    const next = async () => {
      const frame = await iterator.next()
      if (frame.done) return undefined
      const envelope = Envelope.parse(decode(frame.value.body))
      const payload: unknown = decode(envelope.p)
      if (envelope.t === 'core.tcp.failed') throw new Error(Failure.parse(payload).error)
      return { type: envelope.t, payload }
    }
    if ((await next())?.type !== 'core.tcp.connected') throw new Error('microsandbox TCP stream did not connect')
    clearTimeout(timer)
    const send = (type: string, payload: unknown) => client.send(stream.id, 0, message(type, payload))
    let wake: (() => void) | undefined
    const socket = new Duplex({
      read() {
        wake?.()
        wake = undefined
      },
      write(chunk: Buffer, _encoding, callback) {
        void send('data', { data: chunk }).then(() => callback(), callback)
      },
      // ws corks its frame header and payload; sending them separately triggers delayed ACK latency.
      writev(chunks, callback) {
        void send('data', { data: Buffer.concat(chunks.map(({ chunk }) => chunk as Buffer)) }).then(
          () => callback(),
          callback
        )
      },
      final(callback) {
        void send('eof', {}).then(() => callback(), callback)
      },
      destroy(error, callback) {
        wake?.()
        void client.close().then(() => callback(error), callback)
      }
    })
    void (async () => {
      while (!socket.destroyed) {
        const frame = await next()
        if (!frame || frame.type === 'core.tcp.eof' || frame.type === 'core.tcp.closed') break
        if (frame.type !== 'core.tcp.data') throw new Error('microsandbox emitted an unsupported TCP event')
        if (!socket.push(Buffer.from(Data.parse(frame.payload).data))) {
          await new Promise<void>((resolve) => (wake = resolve))
        }
      }
      socket.push(null)
    })().catch((error: Error) => socket.destroy(error))
    return socket
  } catch (error) {
    await client.close()
    throw error
  } finally {
    clearTimeout(timer)
  }
}
