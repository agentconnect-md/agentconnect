// No 'use client' here: reached only from the console's client trees, like `marks.tsx`'s other callers.

import type { ComponentType } from 'react'
import type { CodeHostProvider } from '@agentconnect.md/protocol/code-host'
import { AzureDevOpsMark, GiteaMark, GithubMark, GitlabMark } from '@/components/marks'

// One mark per code host on the GitHub mark's prop set (the multi-color tanuki ignores `color`); total, so a new host brings its own.
const CODE_HOST_MARK: Record<CodeHostProvider, ComponentType<{ color?: string; fillPct?: number }>> = {
  github: GithubMark,
  gitlab: GitlabMark,
  gitea: GiteaMark,
  'azure-devops': AzureDevOpsMark
}

/** The brand mark of one code host — the provider-keyed reading of `GithubMark` / `GitlabMark`. */
export function CodeHostMark({
  provider,
  color,
  fillPct
}: {
  provider: CodeHostProvider
  color?: string
  fillPct?: number
}) {
  const Mark = CODE_HOST_MARK[provider]
  return <Mark color={color} fillPct={fillPct} />
}
