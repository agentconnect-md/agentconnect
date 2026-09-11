// No 'use client' here: reached only from the console's client trees, like `marks.tsx`'s other callers.

import type { ComponentType } from 'react'
import type { CodeHostProvider } from '@agentconnect.md/protocol/code-host'
import { GiteaMark, GithubMark, GitlabMark } from '@/components/marks'

// One mark per code host, normalized to the GitHub mark's prop set so a selection site can render
// whichever provider it holds. The tanuki is multi-color and ignores `color`, exactly as it does
// where it is named directly. Total: a new host brings its own mark here.
const CODE_HOST_MARK: Record<CodeHostProvider, ComponentType<{ color?: string; fillPct?: number }>> = {
  github: GithubMark,
  gitlab: GitlabMark,
  gitea: GiteaMark
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
