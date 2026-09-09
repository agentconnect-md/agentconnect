import type { ExecEvent, Sandbox } from 'microsandbox'
import { z } from 'zod'

const MessageSchema = z.object({ v: z.literal(7), t: z.string(), p: z.instanceof(Uint8Array) })
const DataSchema = z.object({ data: z.instanceof(Uint8Array) })
const ErrorSchema = z.object({ message: z.string() })
const ConfigSchema = z.object({
  env: z.array(z.object({ key: z.string(), value: z.string() })).default([]),
  runtime: z.object({ workdir: z.string().nullable().optional(), user: z.string().nullable().optional() })
})

// The pinned SDK exposes deterministic close on AgentClient, but not on its typed exec handles.
export async function openExecStream(
  sdk: Pick<typeof import('microsandbox'), 'AgentClient'>,
  sandbox: Sandbox,
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {}
) {
  const { decode, encode } = await import('cborg')
  const message = (type: string, payload: unknown) =>
    Buffer.from(encode({ v: 7, t: `core.exec.${type}`, p: encode(payload) }))
  const config = ConfigSchema.parse(await sandbox.config())
  const env = { ...Object.fromEntries(config.env.map(({ key, value }) => [key, value])), ...options.env }
  const client = await sdk.AgentClient.connectSandbox(sandbox.name)
  try {
    const stream = await client.stream(
      2,
      message('request', {
        cmd: command,
        args,
        env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
        cwd: options.cwd ?? config.runtime.workdir ?? '/',
        user: config.runtime.user ?? null,
        tty: false
      })
    )
    const send = (type: string, payload: unknown) => client.send(stream.id, 0, message(type, payload))
    let closing: Promise<void> | undefined
    let stdinTaken = false
    let stdinClosed = false
    return {
      close: () => (closing ??= client.close()),
      signal: (signal: number) => send('signal', { signal }),
      kill: () => send('signal', { signal: 9 }),
      async takeStdin() {
        if (stdinTaken) return null
        stdinTaken = true
        return {
          write: (data: Uint8Array) => send('stdin', { data }),
          async close() {
            if (stdinClosed) return
            stdinClosed = true
            await send('stdin', { data: new Uint8Array() })
          }
        }
      },
      async *[Symbol.asyncIterator](): AsyncGenerator<ExecEvent> {
        for await (const frame of stream) {
          const envelope = MessageSchema.parse(decode(frame.body))
          const payload: unknown = decode(envelope.p)
          switch (envelope.t) {
            case 'core.exec.started':
              yield { kind: 'started', ...z.object({ pid: z.number().int() }).parse(payload) }
              break
            case 'core.exec.stdout':
              yield { kind: 'stdout', ...DataSchema.parse(payload) }
              break
            case 'core.exec.stderr':
              yield { kind: 'stderr', ...DataSchema.parse(payload) }
              break
            case 'core.exec.exited':
              yield { kind: 'exited', ...z.object({ code: z.number().int() }).parse(payload) }
              return
            case 'core.exec.failed':
            case 'core.exec.stdin.error':
              throw new Error(`microsandbox exec failed: ${ErrorSchema.parse(payload).message}`)
            default:
              throw new Error('microsandbox emitted an unsupported exec event')
          }
        }
      }
    }
  } catch (error) {
    await client.close()
    throw error
  }
}

export type MicrosandboxExecStream = Awaited<ReturnType<typeof openExecStream>>
export type MicrosandboxExecStdin = NonNullable<Awaited<ReturnType<MicrosandboxExecStream['takeStdin']>>>
