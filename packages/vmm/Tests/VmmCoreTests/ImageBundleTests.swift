import Foundation
import Testing
@testable import VmmCore

private struct FakeFS: FileProbing {
    var files: Set<String> = []
    var directories: Set<String> = []
    func fileExists(atPath path: String) -> Bool { files.contains(path) }
    func directoryExists(atPath path: String) -> Bool { directories.contains(path) }
}

@Suite struct ImageBundleTests {
    static let manifest = Manifest(
        suite: "trixie",
        architecture: "arm64",
        kernelCommandLine: "console=hvc0 root=/dev/vda rw",
        createdAt: "2026-08-24T12:00:00Z"
    )

    @Test func exposesExpectedLayout() {
        let bundle = ImageBundle(root: URL(filePath: "/tmp/img"))
        #expect(bundle.kernel.path == "/tmp/img/kernel")
        #expect(bundle.initrd.path == "/tmp/img/initrd.img")
        #expect(bundle.disk.path == "/tmp/img/disk.img")
        #expect(bundle.manifestFile.path == "/tmp/img/manifest.json")
    }

    @Test func reportsMissingBundle() {
        let bundle = ImageBundle(root: URL(filePath: "/tmp/img"))
        #expect(throws: VmmError.bundleNotFound(path: "/tmp/img")) {
            try bundle.load(using: FakeFS())
        }
    }

    @Test func reportsMissingMembers() {
        let bundle = ImageBundle(root: URL(filePath: "/tmp/img"))
        let fs = FakeFS(files: ["/tmp/img/kernel"], directories: ["/tmp/img"])
        #expect(throws: VmmError.bundleFileMissing(path: "/tmp/img/disk.img")) {
            try bundle.load(using: fs)
        }
    }

    @Test func initrdIsOptional() throws {
        let root = try TemporaryDirectory()
        let bundle = ImageBundle(root: root.url)
        #expect(!bundle.hasInitrd())
        try Data().write(to: bundle.initrd)
        #expect(bundle.hasInitrd())
    }


    @Test func roundTripsManifest() throws {
        let root = try TemporaryDirectory()
        let bundle = ImageBundle(root: root.url)
        for file in [bundle.kernel, bundle.disk] {
            try Data("x".utf8).write(to: file)
        }
        try JSONEncoder().encode(Self.manifest).write(to: bundle.manifestFile)
        #expect(try bundle.load() == Self.manifest)
    }

    /// An image built before bridgedPorts/docker existed must still load.
    @Test func fillsInFieldsMissingFromOlderManifests() throws {
        let json = """
        {"suite":"trixie","architecture":"arm64",         "kernelCommandLine":"console=hvc0","createdAt":"2026-08-24T12:00:00Z"}
        """
        let manifest = try JSONDecoder().decode(Manifest.self, from: Data(json.utf8))
        #expect(manifest.bridgedPorts == [22, 9515])
        #expect(!manifest.docker)
        #expect(manifest.dockerVersion == nil)
    }

    @Test func readsDockerFieldsWhenPresent() throws {
        let json = """
        {"suite":"trixie","architecture":"arm64",         "kernelCommandLine":"console=hvc0","createdAt":"2026-08-24T12:00:00Z",
         "bridgedPorts":[22,9515,5432],"docker":true,"dockerVersion":"26.1.5+dfsg1-9+deb13u1"}
        """
        let manifest = try JSONDecoder().decode(Manifest.self, from: Data(json.utf8))
        #expect(manifest.bridgedPorts == [22, 9515, 5432])
        #expect(manifest.docker)
        #expect(manifest.dockerVersion == "26.1.5+dfsg1-9+deb13u1")
    }

    @Test func rejectsCorruptManifest() throws {
        let root = try TemporaryDirectory()
        let bundle = ImageBundle(root: root.url)
        for file in [bundle.kernel, bundle.disk] {
            try Data("x".utf8).write(to: file)
        }
        try Data("{not json".utf8).write(to: bundle.manifestFile)
        #expect(throws: VmmError.self) { try bundle.load() }
    }
}

final class TemporaryDirectory {
    let url: URL

    init() throws {
        url = URL(filePath: NSTemporaryDirectory())
            .appending(path: "vmm-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }

    deinit {
        try? FileManager.default.removeItem(at: url)
    }
}

@Suite struct ManifestBridgingTests {
    static let manifest = Manifest(
        suite: "trixie",
        architecture: "arm64",
        kernelCommandLine: "console=hvc0",
        createdAt: "2026-08-24T12:00:00Z",
        bridgedPorts: [22, 9515]
    )

    @Test func reportsBridgedPorts() {
        #expect(Self.manifest.bridgedPorts == [22, 9515])
    }

    @Test func acceptsPostgresOnceTheImageBridgesIt() throws {
        var manifest = Self.manifest
        manifest.bridgedPorts = [22, 9515, 5432]
        let forwards = [PortForward(hostPort: 15432, guestPort: 5432)]
        #expect(manifest.unbridged(forwards).isEmpty)
        #expect(Self.manifest.unbridged(forwards) == forwards)
    }

    @Test func acceptsForwardsTheImageBridges() {
        let forwards = [
            PortForward(hostPort: 9515, guestPort: 9515),
            PortForward(hostPort: 2222, guestPort: 22),
        ]
        #expect(Self.manifest.unbridged(forwards).isEmpty)
    }

    @Test func flagsForwardsWithNoGuestListener() {
        let forwards = [
            PortForward(hostPort: 9515, guestPort: 9515),
            PortForward(hostPort: 18080, guestPort: 80),
        ]
        #expect(Self.manifest.unbridged(forwards) == [PortForward(hostPort: 18080, guestPort: 80)])
    }

    @Test func hostPortIsIrrelevantToBridging() {
        #expect(Self.manifest.unbridged([PortForward(hostPort: 40000, guestPort: 22)]).isEmpty)
    }
}
