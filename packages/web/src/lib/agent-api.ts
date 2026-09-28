// An agent's chat APIs: the protocols offered, this deployment's endpoints, and a proxy snippet (shared-bot-relay.md §10.4).
import type { AgentApiProtocol } from './api'

/** Every protocol the Add API pane lists, in order; one that is not yet `available` shows as coming. */
export const API_PROTOCOLS: readonly {
  id: AgentApiProtocol | 'acp-2'
  label: string
  docsUrl: string
  available: boolean
}[] = [
  { id: 'ai-sdk-ui', label: 'AI SDK UI', docsUrl: 'https://ai-sdk.dev/docs/ai-sdk-ui', available: true },
  { id: 'acp-2', label: 'ACP 2', docsUrl: 'https://agentclientprotocol.com', available: false }
]

export const apiProtocolLabel = (id: string): string => API_PROTOCOLS.find((p) => p.id === id)?.label ?? id

export interface AgentChatUrls {
  /** The Control Plane route that mints a conversation's token with an Agent chat key. */
  mintUrl: string
  /** The relay route one turn is posted to, or null when the deployment names no relay. */
  chatTemplate: string | null
}

/** Public relay ingress injected into the Web image at request time (see public-env.tsx). */
export function agentApiRelayUrl(): string | undefined {
  const runtime = typeof window !== 'undefined' ? window.__AC_ENV?.RELAY_URL : undefined
  return (
    runtime || process.env.RELAY_URL || process.env.PUBLIC_RELAY_URL || process.env.NEXT_PUBLIC_RELAY_URL || undefined
  )
}

export function agentChatUrls(apiBase: string, orgId: string, agentId: string, relayUrl?: string): AgentChatUrls {
  const base = apiBase.replace(/\/+$/, '')
  const relay = relayUrl?.replace(/\/+$/, '')
  return {
    mintUrl: `${base}/orgs/${encodeURIComponent(orgId)}/agents/${encodeURIComponent(agentId)}/webchat/token`,
    chatTemplate: relay ? `${relay}/ai-sdk/chat/{conversationId}` : null
  }
}

/** A server-side proxy for `useChat`: the key mints a conversation's token, and each turn is forwarded with it. */
export function aiSdkProxySnippet(mintUrl: string): string {
  return `// Server: the key stays here. Mint once per conversation and reuse the token until expiresAt.
const minted = await fetch(${JSON.stringify(mintUrl)}, {
  method: "POST",
  headers: { Authorization: \`Bearer \${process.env.AGENTCONNECT_API_KEY}\` },
}).then((res) => res.json());

// Each turn: forward the useChat request body and stream the answer back.
const answer = await fetch(\`\${minted.relayUrl}/ai-sdk/chat/\${minted.conversationId}\`, {
  method: "POST",
  headers: { Authorization: \`Bearer \${minted.token}\`, "Content-Type": "application/json" },
  body: await request.text(),
});

// Browser
const { messages, sendMessage } = useChat({
  transport: new DefaultChatTransport({ api: "/api/chat" }),
});`
}
