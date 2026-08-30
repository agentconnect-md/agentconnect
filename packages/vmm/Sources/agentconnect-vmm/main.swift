import Foundation
import VmmCore

@main
struct Main {
    static func main() async {
        do {
            let invocation = try CLI.parse(arguments: Array(CommandLine.arguments.dropFirst()))
            switch invocation.subcommand {
            case .help:
                print(CLI.usage)
            case .version:
                print(VmmVersion.current)
            case .info:
                try info(invocation.options)
            case .run:
                exit(try await run(invocation.options))
            }
        } catch {
            FileHandle.standardError.write(Data("vmm: \(error)\n".utf8))
            exit(2)
        }
    }

    static func bundle(_ options: RunOptions) -> ImageBundle {
        ImageBundle(root: URL(filePath: options.bundlePath).absoluteURL)
    }

    static func info(_ options: RunOptions) throws {
        let bundle = bundle(options)
        let manifest = try bundle.load()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        print(String(decoding: try encoder.encode(manifest), as: UTF8.self))
    }

    static func run(_ options: RunOptions) async throws -> Int32 {
        let bundle = bundle(options)
        let manifest = try bundle.load()
        let spec = VirtualMachineFactory.resolve(options: options, manifest: manifest, bundle: bundle)
        let console = try options.consoleLogPath.map { try SerialConsole.detached(logPath: $0) } ?? SerialConsole()
        let session = await VirtualMachineSession(
            spec: spec,
            forwards: options.forwards,
            console: console,
            reporter: LifecycleReporter(enabled: options.jsonEvents)
        )
        return try await session.run()
    }
}
