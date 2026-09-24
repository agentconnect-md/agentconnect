export function reachableSteps<T>(
  root: T,
  steps: Array<T & { id: string }>,
  edges: (step: T) => string[]
): Array<T & { id: string }> {
  const reached = new Set<string>()
  const visit = (step: T) => {
    for (const id of edges(step)) {
      const next = steps.find((entry) => entry.id === id)
      if (next && !reached.has(id)) {
        reached.add(id)
        visit(next)
      }
    }
  }
  visit(root)
  return steps.filter((step) => reached.has(step.id))
}
