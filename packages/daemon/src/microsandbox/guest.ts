import { MAX_FRAME_BYTES } from '@agentconnect.md/protocol'
import { GitExecResultSchema, ShimGitRunner, type GitExecPayload } from '../shim/git-exec.js'
import { ShimChannelLostError, type ShimRequester } from '../shim/channels.js'
import { ShimWorkspaceFs } from '../shim/workspace-fs-channel.js'
import { GitTransportError, type GitRunner } from '../workspace/git-runner.js'
import type { WorkspaceFs } from '../workspace/workspace-fs.js'

export const MICROSANDBOX_NODE = '/usr/local/bin/node'
export const MICROSANDBOX_GUEST_ENTRY = '/opt/agentconnect-local/guest.js'
export const MICROSANDBOX_SOCKET_BRIDGES = [
  { path: '/run/agentconnect/mcp.sock', port: 5000 },
  { path: '/run/agentconnect/gitcred.sock', port: 5001 }
] as const

export interface MicrosandboxExecuteOptions {
  env?: Record<string, string>
  cwd?: string
  abort?: AbortSignal
  timeoutMs?: number
  maxBytes?: number
}

export type MicrosandboxExecute = (
  command: string,
  args: string[],
  options?: MicrosandboxExecuteOptions
) => Promise<{ exitCode: number; stdout: string; stderr: string }>

interface GuestRequestOptions {
  execute: MicrosandboxExecute
  workspaceRoot: string
}

function guestRequester(options: GuestRequestOptions): ShimRequester {
  return {
    request: async (capability, payload, requestOptions) => {
      let result
      try {
        result = await options.execute(
          MICROSANDBOX_NODE,
          [MICROSANDBOX_GUEST_ENTRY, JSON.stringify({ workspaceRoot: options.workspaceRoot, capability, payload })],
          { ...requestOptions, maxBytes: MAX_FRAME_BYTES }
        )
      } catch (error) {
        throw new ShimChannelLostError(`microsandbox could not execute the request: ${String(error)}`)
      }
      if (result.exitCode !== 0) {
        throw new ShimChannelLostError(
          result.stderr.trim() || `microsandbox guest handler exited with code ${result.exitCode}`
        )
      }
      try {
        return JSON.parse(result.stdout)
      } catch {
        throw new ShimChannelLostError('microsandbox guest handler returned invalid JSON')
      }
    }
  }
}

export function microsandboxWorkspaceFs(options: GuestRequestOptions): WorkspaceFs {
  return new ShimWorkspaceFs({ ...guestRequester(options), agentId: options.workspaceRoot }, options.workspaceRoot)
}

/** Each Git request runs the existing guest handler in a disposable process. */
export function microsandboxGitRunner(options: {
  execute: MicrosandboxExecute
  workspaceRoot: string
  cwd?: string
  env?: Record<string, string>
  mapEnv?: (env: Record<string, string>) => Record<string, string>
  abort?: AbortSignal
}): GitRunner {
  const requester = guestRequester(options)
  return new ShimGitRunner(
    {
      request: async (_capability, payload, requestOptions) => {
        const gitPayload = payload as GitExecPayload
        if (gitPayload.env !== undefined && options.mapEnv) {
          payload = { ...gitPayload, env: options.mapEnv({ ...gitPayload.env }) }
        }
        try {
          return GitExecResultSchema.parse(await requester.request('exec', payload, requestOptions))
        } catch (error) {
          throw new GitTransportError(error instanceof Error ? error.message : String(error), error)
        }
      }
    },
    options.cwd,
    options.env,
    options.abort
  )
}
