import Foundation
import Testing
import Virtualization
@testable import VmmCore

@Suite struct VirtualMachineFactoryTests {
    static let manifest = Manifest(
        suite: "trixie",
        architecture: "arm64",
        kernelCommandLine: "console=hvc0 root=/dev/vda rw quiet",
        createdAt: "2026-08-24T12:00:00Z"
    )

    static func spec(_ options: RunOptions) -> VirtualMachineSpec {
        VirtualMachineFactory.resolve(
            options: options,
            manifest: manifest,
            bundle: ImageBundle(root: URL(filePath: "/tmp/img"))
        )
    }

    @Test func usesManifestCommandLineUnchanged() {
        #expect(Self.spec(RunOptions()).kernelCommandLine == Self.manifest.kernelCommandLine)
    }

    @Test func kernelArgOverridesManifestValue() {
        var options = RunOptions()
        options.extraKernelArgs = ["loglevel=7", "quiet"]
        let rendered = Self.spec(options).kernelCommandLine
        #expect(rendered == "console=hvc0 root=/dev/vda rw loglevel=7 quiet")
    }

    @Test func clampsCPUCountIntoAllowedRange() {
        #expect(VirtualMachineFactory.clampCPUCount(1) >= VZVirtualMachineConfiguration.minimumAllowedCPUCount)
        #expect(VirtualMachineFactory.clampCPUCount(4096) <= VZVirtualMachineConfiguration.maximumAllowedCPUCount)
        #expect(VirtualMachineFactory.clampCPUCount(2) == 2)
    }

    @Test func clampsMemoryIntoAllowedRange() {
        #expect(VirtualMachineFactory.clampMemory(1) == VZVirtualMachineConfiguration.minimumAllowedMemorySize)
        #expect(VirtualMachineFactory.clampMemory(.max) == VZVirtualMachineConfiguration.maximumAllowedMemorySize)
        #expect(VirtualMachineFactory.clampMemory(4 << 30) == 4 << 30)
    }

    @Test func defaultsAreSane() {
        let resolved = Self.spec(RunOptions())
        #expect(resolved.memoryBytes == 4 << 30)
        #expect(resolved.cpuCount >= 2)
        #expect(resolved.network)
        #expect(!resolved.rosetta)
    }

    @Test func buildsOneVirtiofsDevicePerShare() throws {
        var options = RunOptions()
        options.shares = [
            DirectoryShare(tag: "out", path: "/tmp"),
            DirectoryShare(tag: "src", path: "/usr", readOnly: true),
        ]
        let devices = try VirtualMachineFactory.makeSharingDevices(Self.spec(options))
        let tags = devices.compactMap { ($0 as? VZVirtioFileSystemDeviceConfiguration)?.tag }
        #expect(tags == ["out", "src"])
    }

    @Test func addsRosettaTagWhenRequested() throws {
        var options = RunOptions()
        options.rosetta = true
        guard VZLinuxRosettaDirectoryShare.availability == .installed else { return }
        let devices = try VirtualMachineFactory.makeSharingDevices(Self.spec(options))
        let tags = devices.compactMap { ($0 as? VZVirtioFileSystemDeviceConfiguration)?.tag }
        #expect(tags == ["rosetta"])
    }

    @Test func buildsValidConfigurationFromRealFiles() throws {
        let root = try TemporaryDirectory()
        let bundle = ImageBundle(root: root.url)
        try Data(repeating: 0, count: 4096).write(to: bundle.kernel)
        try Data(repeating: 0, count: 1 << 20).write(to: bundle.disk)

        var options = RunOptions()
        options.shares = [DirectoryShare(tag: "out", path: root.url.path)]
        let spec = VirtualMachineFactory.resolve(options: options, manifest: Self.manifest, bundle: bundle)
        let configuration = try VirtualMachineFactory.assemble(
            spec,
            console: SerialConsole().configuration
        )

        #expect(configuration.cpuCount == spec.cpuCount)
        #expect(configuration.memorySize == spec.memoryBytes)
        #expect(configuration.storageDevices.count == 1)
        #expect(configuration.networkDevices.count == 1)
        #expect(configuration.socketDevices.count == 1)
        #expect(configuration.entropyDevices.count == 1)
        #expect(configuration.directorySharingDevices.count == 1)
        let bootLoader = configuration.bootLoader as? VZLinuxBootLoader
        #expect(bootLoader?.commandLine == Self.manifest.kernelCommandLine)
        #expect(bootLoader?.initialRamdiskURL == nil)
    }

    @Test func omitsNetworkDeviceWhenDisabled() throws {
        let root = try TemporaryDirectory()
        let bundle = ImageBundle(root: root.url)
        try Data(repeating: 0, count: 4096).write(to: bundle.kernel)
        try Data(repeating: 0, count: 1 << 20).write(to: bundle.disk)

        var options = RunOptions()
        options.network = false
        let spec = VirtualMachineFactory.resolve(options: options, manifest: Self.manifest, bundle: bundle)
        let configuration = try VirtualMachineFactory.assemble(
            spec,
            console: SerialConsole().configuration
        )
        #expect(configuration.networkDevices.isEmpty)
    }

    /// Passes signed (validate succeeds) and unsigned (clear notEntitled error),
    /// which are the only two states a developer can be in.
    @Test func validationDependsOnEntitlement() throws {
        let root = try TemporaryDirectory()
        let bundle = ImageBundle(root: root.url)
        try Data(repeating: 0, count: 4096).write(to: bundle.kernel)
        try Data(repeating: 0, count: 1 << 20).write(to: bundle.disk)
        let spec = VirtualMachineFactory.resolve(options: RunOptions(), manifest: Self.manifest, bundle: bundle)

        if Entitlements.canVirtualize {
            #expect(throws: Never.self) {
                try VirtualMachineFactory.makeConfiguration(spec, console: SerialConsole().configuration)
            }
        } else {
            #expect(throws: VmmError.notEntitled) {
                try VirtualMachineFactory.makeConfiguration(spec, console: SerialConsole().configuration)
            }
        }
    }

    @Test func attachesDataDiskAsASecondBlockDevice() throws {
        let root = try TemporaryDirectory()
        let bundle = ImageBundle(root: root.url)
        try Data(repeating: 0, count: 4096).write(to: bundle.kernel)
        try Data(repeating: 0, count: 1 << 20).write(to: bundle.disk)
        let dataDisk = root.url.appending(path: "agent.img")
        try Data(repeating: 0, count: 1 << 20).write(to: dataDisk)

        var options = RunOptions()
        options.dataDiskPath = dataDisk.path
        let spec = VirtualMachineFactory.resolve(options: options, manifest: Self.manifest, bundle: bundle)
        let configuration = try VirtualMachineFactory.assemble(spec, console: SerialConsole().configuration)
        #expect(configuration.storageDevices.count == 2)
    }

    @Test func refusesAMissingDataDiskRatherThanBootingWithout() throws {
        var options = RunOptions()
        options.dataDiskPath = "/tmp/definitely-not-here-\(UUID().uuidString).img"
        #expect(throws: VmmError.dataDiskMissing(path: options.dataDiskPath!)) {
            try VirtualMachineFactory.dataDiskDevices(Self.spec(options))
        }
    }

    @Test func attachesNoDataDiskDeviceByDefault() throws {
        #expect(try VirtualMachineFactory.dataDiskDevices(Self.spec(RunOptions())).isEmpty)
    }

    @Test func picksUpInitrdWhenPresent() throws {
        let root = try TemporaryDirectory()
        let bundle = ImageBundle(root: root.url)
        try Data(repeating: 0, count: 4096).write(to: bundle.kernel)
        try Data(repeating: 0, count: 4096).write(to: bundle.initrd)
        try Data(repeating: 0, count: 1 << 20).write(to: bundle.disk)

        let spec = VirtualMachineFactory.resolve(options: RunOptions(), manifest: Self.manifest, bundle: bundle)
        let configuration = try VirtualMachineFactory.assemble(
            spec,
            console: SerialConsole().configuration
        )
        let bootLoader = configuration.bootLoader as? VZLinuxBootLoader
        #expect(bootLoader?.initialRamdiskURL == bundle.initrd)
    }
}
