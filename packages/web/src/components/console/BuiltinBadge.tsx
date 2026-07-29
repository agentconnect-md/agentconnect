// The lowercase "builtin" chip a built-in preset agent carries next to its name
// (preset-agents.md §3; deliberately all-lowercase). Neutral `.badge` chip shown
// wherever the agent's identity renders; `show` keeps the call sites terse, like
// <RestrictedLock>. Built-in agents are permanent — the console also hides their
// Delete action (the CP refuses the delete regardless).
export function BuiltinBadge({ show }: { show: boolean }) {
  if (!show) return null
  return (
    <span className="badge flex-none bg-(--surface-active) text-(--text-tertiary)" title="Built-in agent">
      builtin
    </span>
  )
}
