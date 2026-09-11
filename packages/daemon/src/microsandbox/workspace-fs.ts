import { localWorkspaceFs, RoutedWorkspaceFs, type WorkspaceFs } from '../workspace/workspace-fs.js'

// Resolve reads and writes in the same filesystem that the runtime sees.
export class MicrosandboxWorkspaceFs extends RoutedWorkspaceFs {
  constructor(
    private readonly resolve: (path: string) => WorkspaceFs | undefined,
    private readonly releaseMount?: (path: string) => Promise<boolean>
  ) {
    super(async (path) => resolve(path) ?? localWorkspaceFs)
  }

  override async rename(from: string, to: string): Promise<void> {
    return (this.resolve(from) ?? this.resolve(to) ?? localWorkspaceFs).rename(from, to)
  }

  override async rmTree(path: string): Promise<void> {
    // A guest cannot remove its mountpoint; stop that VM before deleting the host source.
    if (await this.releaseMount?.(path)) return localWorkspaceFs.rmTree(path)
    return super.rmTree(path)
  }
}
