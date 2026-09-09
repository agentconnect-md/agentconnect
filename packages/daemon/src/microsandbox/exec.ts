import type { ExecEvent, Sandbox } from 'microsandbox'
import { z } from 'zod'

export const MICROSANDBOX_NODE = '/usr/local/bin/node'

export interface MicrosandboxExecuteOptions {
  env?: Record<string, string>
  inheritEnv?: boolean
  cwd?: string
  abort?: AbortSignal
  timeoutMs?: number
  maxBytes?: number
  stdin?: string
}

export type MicrosandboxExecute = (
  command: string,
  args: string[],
  options?: MicrosandboxExecuteOptions
) => Promise<{ exitCode: number; stdout: string; stderr: string }>

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
  options: Pick<MicrosandboxExecuteOptions, 'cwd' | 'env' | 'inheritEnv'> = {}
) {
  const { decode, encode } = await import('cborg')
  const message = (type: string, payload: unknown) =>
    Buffer.from(encode({ v: 7, t: `core.exec.${type}`, p: encode(payload) }))
  const config = ConfigSchema.parse(await sandbox.config())
  const env = {
    ...(options.inheritEnv === false ? {} : Object.fromEntries(config.env.map(({ key, value }) => [key, value]))),
    ...options.env
  }
  const entries = Object.entries(env).map(([key, value]) => `${key}=${value}`)
  // The guest agent inherits its own environment even when the request sends none.
  const replaceEnv = options.inheritEnv === false
  const client = await sdk.AgentClient.connectSandbox(sandbox.name)
  try {
    const stream = await client.stream(
      2,
      message('request', {
        cmd: replaceEnv ? '/usr/bin/env' : command,
        args: replaceEnv ? ['-i', '--', ...entries, command, ...args] : args,
        env: replaceEnv ? [] : entries,
        cwd: options.cwd ?? config.runtime.workdir ?? '/',
        user: config.runtime.user ?? null,
        tty: false
      })
    )
    const send = (type: string, payload: unknown) => client.send(stream.id, 0, message(type, payload))
    let closing: Promise<void> | undefined
    let stdinTaken = false
    let stdinClosed = false
    let terminal = false
    return {
      get terminal() {
        return terminal
      },
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
          terminal ||= (frame.flags & 1) !== 0
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
