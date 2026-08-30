# Testing

```sh
make test                                              # Swift suite, signed
python3 scripts/guest/test_extract_kernel.py           # kernel unwrapping
bash -n scripts/build-base-image.sh scripts/guest/*.sh # shell syntax
```

## Swift suite

`make test` rather than `swift test`, because
`VZVirtualMachineConfiguration.validate()` requires the virtualization
entitlement and the test bundle has to be signed to get it. The suite still
passes unsigned: `validationDependsOnEntitlement` asserts the signed path
validates and the unsigned path reports `VirtError.notEntitled`.

| Suite                                     | Covers                                              |
| ----------------------------------------- | --------------------------------------------------- |
| `ByteCountTests`                          | size parsing and formatting, garbage, overflow      |
| `KernelCommandLineTests`                  | override-by-key semantics                           |
| `CLITests`                                | every option, subcommands, malformed input          |
| `PortForwardTests`, `DirectoryShareTests` | spec parsing                                        |
| `ImageBundleTests`                        | layout, missing members, manifest round trip        |
| `VirtualMachineFactoryTests`              | clamping, device assembly, entitlement gate         |
| `FDBridgeTests`                           | relay in both directions, chunking, close detection |

`FDBridgeTests` is the one that earns its keep. It uses socketpairs, so it
reproduces a broken relay in milliseconds instead of as a hung `curl` against a
booted VM.

## What is not covered by unit tests

Booting is not unit testable: it needs a real kernel, a real disk image, and the
entitlement. The end-to-end check is manual:

```sh
./scripts/build-base-image.sh
make build
.build/release/agentconnect-vmm run image --forward 9515:9515 --forward 2222:22

curl -s http://127.0.0.1:9515/status | python3 -m json.tool
```

Then a full WebDriver round trip, which is what actually proves the browser works:

```sh
ID=$(curl -s -X POST http://127.0.0.1:9515/session -H 'Content-Type: application/json' \
  -d '{"capabilities":{"alwaysMatch":{"browserName":"chrome","goog:chromeOptions":{"args":["--headless=new","--disable-dev-shm-usage"]}}}}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["value"]["sessionId"])')

curl -s -X POST "http://127.0.0.1:9515/session/$ID/url" -H 'Content-Type: application/json' \
  -d '{"url":"data:text/html,<title>vmm works</title>"}'
curl -s "http://127.0.0.1:9515/session/$ID/title"
curl -s -X DELETE "http://127.0.0.1:9515/session/$ID"
```

Inside the guest, `browser-smoke` renders a page headless and dumps the DOM.
