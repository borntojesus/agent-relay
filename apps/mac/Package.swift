// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "AgentRelay",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "AgentRelay", targets: ["AgentRelay"]),
        .executable(name: "relay-smoke", targets: ["RelaySmoke"]),
    ],
    targets: [
        // Models, HTTP client, Keychain. No UI, so the smoke CLI can use it too.
        .target(name: "RelayKit"),
        .executableTarget(name: "AgentRelay", dependencies: ["RelayKit"]),
        .executableTarget(name: "RelaySmoke", dependencies: ["RelayKit"]),
    ]
)
