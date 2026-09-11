// ⚠️ NO RELATIVE IMPORTS — a bundler compiles this from source; web's protocol-imports.leaf.test.ts enforces it.

// Sent as `protocolVersion` in the `ui/initialize` result; the official SDK's `App.connect()` rejects a result without it (SEP-1865 Final).
export const MCP_APPS_PROTOCOL_VERSION = '2026-01-26'

// The most text one `ui/message` may carry into the conversation; matches the wire field's bound so a decoded list is clamped before it is refused.
export const MCP_APP_MESSAGE_MAX_CHARS = 4000

// The most model context one app may hold via `ui/update-model-context`; a note for the next turn carried on the session, not a store.
export const MCP_APP_CONTEXT_MAX_CHARS = 4000
