import Foundation
import Virtualization

public struct VirtualMachineSpec: Sendable {
    public let bundle: ImageBundle
    public let manifest: Manifest
    public let cpuCount: Int
    public let memoryBytes: UInt64
    public let kernelCommandLine: String
    public let dataDiskPath: String?
    public let shares: [DirectoryShare]
    public let rosetta: Bool
    public let network: Bool
}

public enum VirtualMachineFactory {
    public static func resolve(options: RunOptions, manifest: Manifest, bundle: ImageBundle) -> VirtualMachineSpec {
        var commandLine = KernelCommandLine(manifest.kernelCommandLine)
        for argument in options.extraKernelArgs {
            commandLine.append(argument)
        }
        return VirtualMachineSpec(
            bundle: bundle,
            manifest: manifest,
            cpuCount: clampCPUCount(options.cpuCount ?? defaultCPUCount()),
            memoryBytes: clampMemory(options.memoryBytes ?? 4 << 30),
            kernelCommandLine: commandLine.rendered,
            dataDiskPath: options.dataDiskPath,
            shares: options.shares,
            rosetta: options.rosetta,
            network: options.network
        )
    }

    static func defaultCPUCount() -> Int {
        max(2, ProcessInfo.processInfo.activeProcessorCount / 2)
    }

    static func clampCPUCount(_ requested: Int) -> Int {
        min(
            max(requested, VZVirtualMachineConfiguration.minimumAllowedCPUCount),
            VZVirtualMachineConfiguration.maximumAllowedCPUCount
        )
    }

    static func clampMemory(_ requested: UInt64) -> UInt64 {
        min(
            max(requested, VZVirtualMachineConfiguration.minimumAllowedMemorySize),
            VZVirtualMachineConfiguration.maximumAllowedMemorySize
        )
    }

    public static func makeConfiguration(
        _ spec: VirtualMachineSpec,
        console: VZSerialPortConfiguration
    ) throws -> VZVirtualMachineConfiguration {
        guard Entitlements.canVirtualize else {
            throw VmmError.notEntitled
        }
        let configuration = try assemble(spec, console: console)
        do {
            try configuration.validate()
        } catch {
            throw VmmError.configurationInvalid(error.localizedDescription)
        }
        return configuration
    }

    public static func assemble(
        _ spec: VirtualMachineSpec,
        console: VZSerialPortConfiguration
    ) throws -> VZVirtualMachineConfiguration {
        let configuration = VZVirtualMachineConfiguration()
        configuration.cpuCount = spec.cpuCount
        configuration.memorySize = spec.memoryBytes

        let bootLoader = VZLinuxBootLoader(kernelURL: spec.bundle.kernel)
        bootLoader.commandLine = spec.kernelCommandLine
        if spec.bundle.hasInitrd() {
            bootLoader.initialRamdiskURL = spec.bundle.initrd
        }
        configuration.bootLoader = bootLoader

        configuration.serialPorts = [console]
        configuration.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
        configuration.memoryBalloonDevices = [VZVirtioTraditionalMemoryBalloonDeviceConfiguration()]
        configuration.socketDevices = [VZVirtioSocketDeviceConfiguration()]

        let attachment = try VZDiskImageStorageDeviceAttachment(
            url: spec.bundle.disk,
            readOnly: false,
            cachingMode: .automatic,
            synchronizationMode: .fsync
        )
        configuration.storageDevices = try [VZVirtioBlockDeviceConfiguration(attachment: attachment)]
            + dataDiskDevices(spec)

        if spec.network {
            let network = VZVirtioNetworkDeviceConfiguration()
            network.attachment = VZNATNetworkDeviceAttachment()
            configuration.networkDevices = [network]
        }

        configuration.directorySharingDevices = try makeSharingDevices(spec)
        return configuration
    }

    /// The rootfs is recreated per boot, so whatever must survive a stop lives on this disk instead.
    static func dataDiskDevices(_ spec: VirtualMachineSpec) throws -> [VZVirtioBlockDeviceConfiguration] {
        guard let path = spec.dataDiskPath else { return [] }
        let url = URL(filePath: path).absoluteURL
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw VmmError.dataDiskMissing(path: url.path)
        }
        let attachment = try VZDiskImageStorageDeviceAttachment(
            url: url,
            readOnly: false,
            cachingMode: .automatic,
            synchronizationMode: .fsync
        )
        return [VZVirtioBlockDeviceConfiguration(attachment: attachment)]
    }

    static func makeSharingDevices(_ spec: VirtualMachineSpec) throws -> [VZDirectorySharingDeviceConfiguration] {
        var devices: [VZDirectorySharingDeviceConfiguration] = spec.shares.map { share in
            let device = VZVirtioFileSystemDeviceConfiguration(tag: share.tag)
            let url = URL(filePath: share.path).absoluteURL
            device.share = VZSingleDirectoryShare(
                directory: VZSharedDirectory(url: url, readOnly: share.readOnly)
            )
            return device
        }

        if spec.rosetta {
            switch VZLinuxRosettaDirectoryShare.availability {
            case .installed:
                let device = VZVirtioFileSystemDeviceConfiguration(tag: "rosetta")
                device.share = try VZLinuxRosettaDirectoryShare()
                devices.append(device)
            case .notInstalled:
                throw VmmError.rosettaUnavailable("not installed, run: softwareupdate --install-rosetta")
            case .notSupported:
                throw VmmError.rosettaUnavailable("not supported on this host")
            @unknown default:
                throw VmmError.rosettaUnavailable("unknown availability state")
            }
        }
        return devices
    }
}
