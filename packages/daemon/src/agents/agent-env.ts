// UI-configured per-agent environment applied on top of runtime.env when
// spawning the ACP child. Write-only secrets win a same-name ordinary env var.
export function agentChildEnv(agent: {
  runtimeOverrides?: { env?: { name: string; value: string }[]; secrets?: { name: string; value: string }[] }
}): Record<string, string> {
  return {
    ...Object.fromEntries((agent.runtimeOverrides?.env ?? []).map((e) => [e.name, e.value])),
    ...Object.fromEntries((agent.runtimeOverrides?.secrets ?? []).map((e) => [e.name, e.value]))
  }
}
