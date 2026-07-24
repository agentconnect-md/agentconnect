# AgentConnect Mem0 memory plugin

First-party, out-of-process implementations of the `agentconnect.memory/v1`
profile. Cloud and OSS are separate adapters because their paths,
authentication, response shapes, and capture semantics differ.

| Dialect | Plugin id            | Upstream API           | Capture     | Record operations              |
| ------- | -------------------- | ---------------------- | ----------- | ------------------------------ |
| Cloud   | `ai.mem0.memory`     | Cloud V3 + scoped V1   | async event | list/get/delete/history        |
| OSS     | `ai.mem0.memory.oss` | `/memories`, `/search` | synchronous | list/get/create/delete/history |

OSS deliberately does not advertise update: its ID-only `PUT` route has no
atomic optimistic precondition, while the AgentConnect profile requires update
plugins to honor the supplied version.

In HTTP mode the plugin exposes Streamable HTTP MCP at `/mcp` and a process-only
readiness probe at `/healthz`. It never receives an AgentConnect relay grant
directly: the relay validates that grant, removes client auth headers, and
injects the connection's reviewed `X-Mem0-Api-Key` header. Cloud converts that
value to `Authorization: Token …`; OSS sends it as `X-API-Key`.

```bash
pnpm --filter @agentconnect.md/memory-plugin-mem0 build
# Cloud over Streamable HTTP (default)
HOST=0.0.0.0 PORT=8788 pnpm --filter @agentconnect.md/memory-plugin-mem0 start

# OSS over Streamable HTTP; upstream is deployment-owned, never tenant config
MEM0_DIALECT=oss MEM0_OSS_BASE_URL=http://127.0.0.1:8888 \
  HOST=0.0.0.0 PORT=8788 pnpm --filter @agentconnect.md/memory-plugin-mem0 start
```

Set standard `OTEL_EXPORTER_OTLP_*` / `OTEL_METRICS_EXPORTER` environment
variables to emit body-free request metrics and traces. Outcomes distinguish
authentication, rate-limit, upstream 5xx, network, and protocol failures; memory
text, turn bodies, and authorization headers are never recorded as attributes.

Register the resulting `https://…/mcp` endpoint as a remote memory-plugin
installation with the corresponding plugin id, profile major `1`, and the
manifest digest returned by the profile. Both adapters use this reviewed secret
contract:

```json
[{ "name": "apiKey", "header": "X-Mem0-Api-Key", "required": true }]
```

Mem0 Cloud is fixed to `https://api.mem0.ai`. The OSS upstream comes only from
the wrapper deployment's `MEM0_OSS_BASE_URL` (default
`http://127.0.0.1:8888`). Tenant connection config cannot redirect either
adapter's second-hop egress. V1 scope uses exactly one Mem0 primary entity:
`agent_id=ac:agent:<agentId>`.

## Operator-allowlisted stdio

The same binary can be installed as a daemon-local stdio plugin. The operator,
not the tenant or control plane, owns the executable, arguments, static env, and
logical-secret-to-env mapping:

```json
{
  "memoryPlugins": {
    "mem0-oss": {
      "command": "node",
      "args": ["/opt/agentconnect/memory-plugin-mem0/dist/cli.js"],
      "env": [
        { "name": "MEM0_DIALECT", "value": "oss" },
        { "name": "MCP_TRANSPORT", "value": "stdio" },
        { "name": "MEM0_OSS_BASE_URL", "value": "http://127.0.0.1:8888" }
      ],
      "secretEnv": { "apiKey": "MEM0_API_KEY" }
    }
  }
}
```

The control-plane installation stores only `commandRef: "mem0-oss"`. The
daemon creates one child per connection, passes the write-only credential only
to that child, caps MCP messages, silences child stderr, and restarts crashes
with backoff. Stdio mode writes no banners or diagnostics to stdout because that
stream is reserved for MCP JSON-RPC.
