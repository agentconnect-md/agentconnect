export interface AgentApiUrls {
  mintUrl: string
  socketTemplate: string | null
}

/** Public relay ingress injected into the Web image at request time (see public-env.tsx). */
export function agentApiRelayUrl(): string | undefined {
  const runtime = typeof window !== 'undefined' ? window.__AC_ENV?.RELAY_URL : undefined
  return (
    runtime || process.env.RELAY_URL || process.env.PUBLIC_RELAY_URL || process.env.NEXT_PUBLIC_RELAY_URL || undefined
  )
}

/** The API tab documents the exact versioned CP endpoint exposed by this deployment.
 * The caller supplies the deployment's relay origin; short-lived response fields remain
 * placeholders until the mint request succeeds. */
export function agentApiUrls(apiBase: string, orgId: string, agentId: string, relayUrl?: string): AgentApiUrls {
  const base = apiBase.replace(/\/+$/, '')
  const mintUrl = `${base}/orgs/${encodeURIComponent(orgId)}/agents/${encodeURIComponent(agentId)}/webchat/token`
  const relayBase = relayUrl?.replace(/^http/, 'ws').replace(/\/+$/, '')
  return {
    mintUrl,
    socketTemplate: relayBase ? `${relayBase}/webchat?token=<token>&conversation_id=<conversationId>` : null
  }
}

export function agentApiSnippet(mintUrl: string, prompt: string): string {
  return `const response = await fetch(${JSON.stringify(mintUrl)}, {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${process.env.AGENTCONNECT_API_KEY}\`,
    "Content-Type": "application/json",
  },
  body: "{}",
});

if (!response.ok) throw new Error(\`Credential request failed: \${response.status}\`);
const credentials = await response.json();

const relayUrl = credentials.relayUrl.replace(/^http/, "ws").replace(/\\/+$/, "");
const query = new URLSearchParams({
  token: credentials.token,
  conversation_id: credentials.conversationId,
});
const ws = new WebSocket(\`\${relayUrl}/webchat?\${query}\`);

ws.addEventListener("open", () => {
  ws.send(JSON.stringify({ text: ${JSON.stringify(prompt)} }));
});

ws.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (message.type === "output" && message.output.event?.kind === "message") {
    process.stdout.write(message.output.event.text);
  }
  if (message.type === "done") console.log("done", message.done.usage);
  if (message.type === "error") console.error(message.message);
});`
}
