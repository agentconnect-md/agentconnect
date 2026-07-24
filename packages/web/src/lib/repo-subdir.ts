const MAX_AGENT_DIR_LENGTH = 1024

export class AgentDirValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentDirValidationError'
  }
}

/** Browser-side mirror of the CP's repository-subdirectory input contract. */
export function normalizeAgentDir(input: string | null | undefined): string | undefined {
  const trimmed = input?.trim() ?? ''
  if (!trimmed || trimmed === '/' || trimmed === '.' || trimmed === './') return undefined

  const normalized = trimmed.startsWith('./') ? trimmed.slice(2) : trimmed
  if (normalized.length > MAX_AGENT_DIR_LENGTH) {
    throw new AgentDirValidationError(`Working subdirectory must be at most ${MAX_AGENT_DIR_LENGTH} characters.`)
  }
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new AgentDirValidationError('Working subdirectory must be relative to the repository.')
  }
  if (normalized.includes('\\')) {
    throw new AgentDirValidationError('Working subdirectory must use forward slashes.')
  }
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new AgentDirValidationError('Working subdirectory must not contain control characters.')
  }
  if (normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new AgentDirValidationError('Working subdirectory must not contain empty, ".", or ".." path segments.')
  }
  return normalized
}

/** Prefill legacy root sentinels as blank while keeping invalid non-root values editable. */
export function agentDirInputValue(input: string | null | undefined): string {
  try {
    return normalizeAgentDir(input) ?? ''
  } catch {
    return input?.trim() ?? ''
  }
}
