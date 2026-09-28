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

/** A server-side proxy for `useChat`: one conversation per browser, its token reused until expiry, the relay stream returned. */
export function aiSdkProxySnippet(mintUrl: string): string {
  return `// app/api/chat/route.ts: the key stays on the server; each browser keeps one conversation.
const tokens = new Map<string, { token: string; relayUrl: string; conversationId: string; expiresAt: string }>();

async function mint(conversationId?: string) {
  const cached = conversationId ? tokens.get(conversationId) : undefined;
  if (cached && Date.parse(cached.expiresAt) - 30_000 > Date.now()) return cached;
  const res = await fetch(${JSON.stringify(mintUrl)}, {
    method: "POST",
    headers: { Authorization: \`Bearer \${process.env.AGENTCONNECT_API_KEY}\`, "Content-Type": "application/json" },
    body: JSON.stringify(conversationId ? { conversationId } : {}),
  });
  if (!res.ok) throw new Error(\`token mint failed: \${res.status}\`);
  const minted = await res.json();
  tokens.set(minted.conversationId, minted);
  return minted;
}

export async function POST(req: Request) {
  const body = await req.text();
  // A lone first question starts a new conversation; later turns continue the browser's one.
  const turns = JSON.parse(body).messages.filter((m: { role: string }) => m.role === "user").length;
  const bound = req.headers.get("cookie")?.match(/chat_conversation=([0-9a-f-]{36})/)?.[1];
  const { token, relayUrl, conversationId } = await mint(turns > 1 ? bound : undefined);
  const upstream = await fetch(\`\${relayUrl}/ai-sdk/chat/\${conversationId}\`, {
    method: "POST",
    headers: { Authorization: \`Bearer \${token}\`, "Content-Type": "application/json" },
    body,
    signal: req.signal,
  });
  const headers = new Headers({ "Cache-Control": "no-store" });
  for (const name of ["content-type", "x-vercel-ai-ui-message-stream"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.append("Set-Cookie", \`chat_conversation=\${conversationId}; Path=/; HttpOnly; Secure; SameSite=Lax\`);
  return new Response(upstream.body, { status: upstream.status, headers });
}

// Browser
const { messages, sendMessage } = useChat({
  transport: new DefaultChatTransport({ api: "/api/chat" }),
});`
}
