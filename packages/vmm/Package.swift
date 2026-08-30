// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "agentconnect-vmm",
    platforms: [.macOS(.v15)],
    targets: [
        .target(name: "VmmCore"),
        .executableTarget(name: "agentconnect-vmm", dependencies: ["VmmCore"]),
        .testTarget(name: "VmmCoreTests", dependencies: ["VmmCore"]),
    ]
)
