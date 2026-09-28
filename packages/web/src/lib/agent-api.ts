// An agent's chat APIs: the protocols offered, this deployment's chat endpoint, and the Quickstart's examples (shared-bot-relay.md §10.4).
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

/** Public relay ingress injected into the Web image at request time (see public-env.tsx). */
export function agentApiRelayUrl(): string | undefined {
  const runtime = typeof window !== 'undefined' ? window.__AC_ENV?.RELAY_URL : undefined
  return (
    runtime || process.env.RELAY_URL || process.env.PUBLIC_RELAY_URL || process.env.NEXT_PUBLIC_RELAY_URL || undefined
  )
}

/** The relay route a turn is posted to with an API key, or null when the deployment names no relay. */
export function agentChatUrl(agentId: string, relayUrl?: string): string | null {
  const relay = relayUrl?.replace(/\/+$/, '')
  return relay ? `${relay}/ai-sdk/agents/${encodeURIComponent(agentId)}/chat` : null
}

export type QuickstartTab = 'curl' | 'node' | 'browser'
export const QUICKSTART_TABS: readonly QuickstartTab[] = ['curl', 'node', 'browser']

/** One file of an example: its name, which also picks its highlighting, and its text. */
export interface QuickstartFile {
  file: string
  code: string
}

/** The Quickstart's examples: a raw request, Node over the AI SDK's transport, and a browser `useChat` behind a same-origin route that adds the key. */
export function quickstartExamples(chatUrl: string): Record<QuickstartTab, QuickstartFile[]> {
  const url = JSON.stringify(chatUrl)
  return {
    curl: [
      {
        file: 'chat.sh',
        code: `curl -N ${chatUrl} \\
  -H "Authorization: Bearer $AGENTCONNECT_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"id":"chat-1","messages":[{"role":"user","parts":[{"type":"text","text":"Hello"}]}]}'`
      }
    ],
    node: [
      {
        file: 'chat.ts',
        code: `// npm i ai (AI SDK 5 or later)
import { DefaultChatTransport } from "ai";

const transport = new DefaultChatTransport({
  api: ${url},
  headers: { Authorization: \`Bearer \${process.env.AGENTCONNECT_API_KEY}\` },
});
const stream = await transport.sendMessages({
  trigger: "submit-message",
  chatId: "chat-1", // the conversation; send the same id again to continue it
  messageId: undefined,
  abortSignal: undefined,
  messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "Hello" }] }],
});
for await (const chunk of stream) if (chunk.type === "text-delta") process.stdout.write(chunk.delta);`
      }
    ],
    browser: [
      {
        file: 'app/api/chat/route.ts',
        code: `// The key stays on the server: this route adds it and forwards useChat's request unchanged.
export async function POST(req: Request) {
  const upstream = await fetch(${url}, {
    method: "POST",
    headers: { Authorization: \`Bearer \${process.env.AGENTCONNECT_API_KEY}\`, "Content-Type": "application/json" },
    body: await req.text(),
    signal: req.signal,
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "Content-Type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" },
  });
}`
      },
      {
        file: 'app/page.tsx',
        code: `// npm i ai @ai-sdk/react (AI SDK 5 or later)
"use client";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";

export default function Chat() {
  const { messages, sendMessage } = useChat({ transport: new DefaultChatTransport({ api: "/api/chat" }) });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const input = e.currentTarget.elements.namedItem("text") as HTMLInputElement;
        sendMessage({ text: input.value });
        input.value = "";
      }}
    >
      {messages.map((m) => (
        <p key={m.id}>{m.parts.map((p) => (p.type === "text" ? p.text : "")).join("")}</p>
      ))}
      <input name="text" />
    </form>
  );
}`
      }
    ]
  }
}
