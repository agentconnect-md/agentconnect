SHELL := /bin/bash
CONFIG ?= release
BIN_DIR := $(shell swift build -c $(CONFIG) --show-bin-path)
BIN := $(BIN_DIR)/agentconnect-vmm
TEST_BIN_DIR := $(shell swift build --build-tests --show-bin-path)
TEST_BUNDLE := $(TEST_BIN_DIR)/agentconnect-vmmPackageTests.xctest
SIGN_ID ?= -
IMAGE ?= image

.PHONY: all build sign test image run shell bench-boot bench-scale clean

all: build

build:
	swift build -c $(CONFIG)
	@$(MAKE) --no-print-directory sign

# Virtualization.framework refuses to run without the entitlement, so signing is
# part of every build rather than a release step.
sign:
	codesign --sign $(SIGN_ID) --entitlements vmm.entitlements --force --timestamp=none "$(BIN)"
	@echo "signed $(BIN)"

test:
	swift build --build-tests
	codesign --sign $(SIGN_ID) --entitlements vmm.entitlements --force --timestamp=none \
		"$(TEST_BUNDLE)/Contents/MacOS/agentconnect-vmmPackageTests" 2>/dev/null || \
	codesign --sign $(SIGN_ID) --entitlements vmm.entitlements --force --timestamp=none "$(TEST_BUNDLE)"
	swift test --skip-build

# FROM must name a runtime-sandbox image; its filesystem is the guest's payload.
FROM ?= runtime-sandbox:latest

image:
	./scripts/build-agent-image.sh --from $(FROM) --output $(IMAGE)

run: build
	$(BIN) run $(IMAGE) --forward 2222:22 --data-disk $(IMAGE)/../agent-data.img

# Second terminal, while `make run` holds the console in the first.
shell:
	./scripts/shell.sh

bench-boot: build
	./scripts/bench.py boot --runs 5

bench-scale: build
	./scripts/bench.py scale --steps 1,2,4,8,10

clean:
	rm -rf .build
