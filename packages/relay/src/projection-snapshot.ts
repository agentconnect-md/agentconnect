// Mark-and-sweep for one relay projection: a CP snapshot names what stays, and its end prunes the rest.
export class ProjectionSnapshot {
  private open?: { id: string; seen: Set<string> }

  /** A full replay starts; one left open by a link that dropped mid-replay is replaced. */
  begin(snapshotId: string): void {
    this.open = { id: snapshotId, seen: new Set() }
  }

  /** An assign landed; while a snapshot is open it names that entry as current. */
  see(id: string): void {
    this.open?.seen.add(id)
  }

  /** The entries to prune when `snapshotId` ends: present, but neither replayed nor withheld; none for a stale end. */
  end(snapshotId: string, present: Iterable<string>, withheld: readonly string[]): string[] {
    const open = this.open
    if (open?.id !== snapshotId) return []
    this.open = undefined
    const keep = new Set([...open.seen, ...withheld])
    return [...present].filter((id) => !keep.has(id))
  }

  /** Forget a snapshot whose link dropped before it ended. */
  abandon(): void {
    this.open = undefined
  }
}
