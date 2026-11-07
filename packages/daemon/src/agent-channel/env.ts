// The agent channel's environment names; a node-builtins-only leaf so the in-sandbox helpers can import it without the daemon's credential cache.

/** The runtime-only per-agent bearer a helper presents on the agent channel. */
export const AGENT_CHANNEL_CAPABILITY_ENV = 'AC_AGENT_CHANNEL_CAPABILITY'
/** The agent identity minted with the capability; helpers prefer it over a `.git/config` helper line's agentId, which can go stale. */
export const AGENT_CHANNEL_AGENT_ENV = 'AC_AGENT_CHANNEL_AGENT'
/** The agent channel socket, when it is not under this daemon's own root (a sandbox reaches it through the shim's tunnel); a path, never a secret. */
export const AGENT_CHANNEL_SOCKET_ENV = 'AC_AGENT_CHANNEL_SOCKET'
