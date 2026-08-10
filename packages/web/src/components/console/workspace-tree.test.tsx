// The shared workspace read model's pure halves: the git-status join a tree's badges come from, and the row glyph. The hooks are exercised through their consumers (dock/FilesPanel.test.tsx, WorkspaceFiles.test.tsx).

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { StatusBadge, workspaceDirtyMap, workspaceEntryIcon } from './workspace-tree'
import type { WorkspaceGitFileDto, WorkspaceGitStatusDto } from '@/lib/api'

function status(files: WorkspaceGitFileDto[], agentDir: string | null = null): WorkspaceGitStatusDto {
  return {
    isRepo: true,
    clean: files.length === 0,
    repo: 'https://github.com/acme/repo.git',
    agentDir,
    branch: 'main',
    tracking: 'origin/main',
    ahead: 0,
    behind: 0,
    files,
    truncated: false,
    lastCommit: null,
    lastFetchAt: null
  }
}

const file = (path: string, index: string, workingDir: string): WorkspaceGitFileDto => ({
  path,
  index,
  workingDir,
  additions: null,
  deletions: null
})

describe('workspaceDirtyMap', () => {
  it('has nothing to join without a status', () => {
    // A scratch workspace and an offline daemon both arrive as null, and neither may badge a row.
    expect(workspaceDirtyMap(null).size).toBe(0)
  })

  it('takes the working-tree letter when nothing is staged', () => {
    // ' M' — X is a space, so the letter has to come from Y.
    expect(workspaceDirtyMap(status([file('src/a.ts', ' ', 'M')])).get('src/a.ts')).toBe('M')
  })

  it('reads untracked off either half of the pair', () => {
    const m = workspaceDirtyMap(status([file('new.ts', '?', '?'), file('half.ts', ' ', '?')]))
    expect(m.get('new.ts')).toBe('U')
    expect(m.get('half.ts')).toBe('U')
  })

  it('shows the STAGED half of a file that is both staged and dirty', () => {
    // 'AM' = staged addition, edited since; 'MM' = staged edit, edited since. One letter cannot carry both, and the index char is the one that wins — the unstaged half is invisible here by design.
    const m = workspaceDirtyMap(
      status([file('added.ts', 'A', 'M'), file('twice.ts', 'M', 'M'), file('gone.ts', 'D', ' ')])
    )
    expect(m.get('added.ts')).toBe('A')
    expect(m.get('twice.ts')).toBe('M')
    expect(m.get('gone.ts')).toBe('D')
  })

  it('falls back to M for a pair with no letters at all', () => {
    expect(workspaceDirtyMap(status([file('odd.ts', ' ', ' ')])).get('odd.ts')).toBe('M')
  })

  it('also indexes the agentDir-relative path, because git paths are repo-relative', () => {
    // The daemon lists from the repo SUBDIR the agent runs in, so 'apps/web/src/a.ts' has to be reachable as 'src/a.ts' too or the badge lands on nothing.
    const m = workspaceDirtyMap(status([file('apps/web/src/a.ts', 'M', ' ')], 'apps/web'))
    expect(m.get('apps/web/src/a.ts')).toBe('M')
    expect(m.get('src/a.ts')).toBe('M')
  })

  it('normalizes a ./-prefixed or trailing-slash agentDir', () => {
    expect(workspaceDirtyMap(status([file('apps/web/a.ts', 'M', ' ')], './apps/web/')).get('a.ts')).toBe('M')
  })

  it('leaves paths outside the agentDir alone', () => {
    // A sibling directory shares no prefix, so nothing may be re-indexed off it.
    const m = workspaceDirtyMap(status([file('apps/api/a.ts', 'M', ' ')], 'apps/web'))
    expect(m.get('apps/api/a.ts')).toBe('M')
    expect([...m.keys()]).toEqual(['apps/api/a.ts'])
  })

  it('keeps the first letter written for a path, not the last', () => {
    const m = workspaceDirtyMap(status([file('dup.ts', 'A', ' '), file('dup.ts', 'D', ' ')]))
    expect(m.get('dup.ts')).toBe('A')
  })

  it('rolls nothing up to the directory that contains a changed file', () => {
    // Only file rows carry a badge; a folder row that implied a dirty descendant would be inventing a wire field.
    const m = workspaceDirtyMap(status([file('src/a.ts', 'M', ' ')]))
    expect(m.has('src')).toBe(false)
  })
})

describe('workspaceEntryIcon', () => {
  const entry = (name: string, type: 'dir' | 'file' | 'symlink' | 'other') => ({ name, type, size: null, mtime: null })

  it('separates the four listing types', () => {
    expect(workspaceEntryIcon(entry('src', 'dir'))).toBe('folder')
    expect(workspaceEntryIcon(entry('link', 'symlink'))).toBe('link-2')
    expect(workspaceEntryIcon(entry('sock', 'other'))).toBe('file-question-mark')
  })

  it('picks the code glyph off the extension for a plain file', () => {
    expect(workspaceEntryIcon(entry('a.ts', 'file'))).toBe('file-code')
    expect(workspaceEntryIcon(entry('NOTES', 'file'))).toBe('file-text')
  })
})

describe('StatusBadge', () => {
  it('names and colours each letter it can be handed', () => {
    // The colour is the only thing separating an addition from a deletion at 15px, and the title is the only thing separating either for a screen reader.
    expect(renderToStaticMarkup(<StatusBadge ch="U" />)).toContain('title="Untracked (uncommitted)"')
    expect(renderToStaticMarkup(<StatusBadge ch="A" />)).toContain('title="Added (uncommitted)"')
    expect(renderToStaticMarkup(<StatusBadge ch="D" />)).toContain('var(--red-500)')
    expect(renderToStaticMarkup(<StatusBadge ch="R" />)).toContain('title="Renamed (uncommitted)"')
    expect(renderToStaticMarkup(<StatusBadge ch="M" />)).toContain('title="Modified (uncommitted)"')
  })
})
