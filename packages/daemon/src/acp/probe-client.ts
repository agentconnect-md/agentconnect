import type { McpServer, SessionConfigOption } from '@agentclientprotocol/sdk'
import type { McpTransportCapabilities } from '@agentconnect.md/protocol'
import type { AcpHost, ModelOptions } from './acp-host.js'

/**
 * The narrow slice of an ACP agent host that runtime probing and model
 * enumeration need: spawn, one disposable session, read the advertised
 * selectors, tear down. Keeping it an interface is what lets `runtimes/*`
 * depend on a contract instead of the concrete {@link AcpHost}.
 *
 * The optional members are optional on purpose — a probe fake implements only
 * what the path it exercises calls, and every caller already guards them.
 */
export interface AcpProbeClient {
  start(): Promise<void>
  newSession(cwd: string, mcpServers?: McpServer[]): Promise<string>
  modelOptions(sessionId?: string): ModelOptions | null
  sessionConfigOptions?(sessionId: string): SessionConfigOption[] | undefined
  setSessionModel?(sessionId: string, model: string): Promise<boolean>
  acpProtocolVersion(): number | undefined
  acpAgentInfo?(): { name: string; title?: string; version?: string } | undefined
  mcpCapabilities?(): McpTransportCapabilities | null
  stop(deadlineMs?: number): Promise<void>
}

// AcpHost is the production implementation — structural conformance fails to compile here.
type ProbeClientShaped<T extends AcpProbeClient> = T
export type AcpHostIsProbeClient = ProbeClientShaped<AcpHost>
