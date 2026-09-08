import { LocalWorkspaceFs, type WorkspaceFs } from '../workspace/workspace-fs.js'

// Existing VMs perform mutations themselves so virtiofs observes directory renames immediately.
export class MicrosandboxWorkspaceFs extends LocalWorkspaceFs {
  constructor(
    private readonly resolve: (path: string) => WorkspaceFs | undefined,
    private readonly releaseMount?: (path: string) => Promise<boolean>
  ) {
    super()
  }

  override async mkdir(path: string, mode?: number): Promise<void> {
    const guest = this.resolve(path)
    return guest ? await guest.mkdir(path, mode) : await super.mkdir(path, mode)
  }

  override async writeFile(path: string, content: string, options?: { mode?: number }): Promise<void> {
    const guest = this.resolve(path)
    return guest ? await guest.writeFile(path, content, options) : await super.writeFile(path, content, options)
  }

  override async rename(from: string, to: string): Promise<void> {
    const guest = this.resolve(from) ?? this.resolve(to)
    return guest ? await guest.rename(from, to) : await super.rename(from, to)
  }

  override async rmdir(path: string): Promise<boolean> {
    const guest = this.resolve(path)
    return guest ? await guest.rmdir(path) : await super.rmdir(path)
  }

  override async rmTree(path: string): Promise<void> {
    // A guest cannot remove its mountpoint; stop that VM before deleting the host source.
    if (await this.releaseMount?.(path)) return await super.rmTree(path)
    const guest = this.resolve(path)
    return guest ? await guest.rmTree(path) : await super.rmTree(path)
  }
}
