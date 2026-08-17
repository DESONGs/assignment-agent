#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUNS_ROOT="${1:-$ROOT/runtime-runs/feishu-agent/runs}"
TARGET="arm64-apple-macosx14.0"
TMP_DIR="$(mktemp -d /private/tmp/assignment-agent-swift-smoke.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

if [[ -n "${ASSIGNMENT_AGENT_SWIFT_SDK:-}" ]]; then
  SDK="$ASSIGNMENT_AGENT_SWIFT_SDK"
else
  SDK=""
  for candidate in \
    /Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk \
    /Library/Developer/CommandLineTools/SDKs/MacOSX15.2.sdk \
    /Library/Developer/CommandLineTools/SDKs/MacOSX15.sdk \
    /Library/Developer/CommandLineTools/SDKs/MacOSX.sdk
  do
    if [[ -d "$candidate" ]]; then
      SDK="$candidate"
      break
    fi
  done
fi

if [[ -z "$SDK" || ! -d "$SDK" ]]; then
  echo '{"status":"blocked","reason":"compatible_macos_sdk_not_found"}' >&2
  exit 2
fi

export CLANG_MODULE_CACHE_PATH="${CLANG_MODULE_CACHE_PATH:-/private/tmp/assignment-agent-clang-cache}"
export SWIFT_MODULE_CACHE_PATH="${SWIFT_MODULE_CACHE_PATH:-/private/tmp/assignment-agent-swift-cache}"
mkdir -p "$CLANG_MODULE_CACHE_PATH" "$SWIFT_MODULE_CACHE_PATH"

swiftc \
  -emit-library \
  -emit-module \
  -parse-as-library \
  -module-name AgentWorkbenchCore \
  -emit-module-path "$TMP_DIR/AgentWorkbenchCore.swiftmodule" \
  -o "$TMP_DIR/libAgentWorkbenchCore.dylib" \
  -sdk "$SDK" \
  -target "$TARGET" \
  "$ROOT"/AgentWorkbench/Sources/AgentWorkbenchCore/*.swift

swiftc \
  -typecheck \
  -parse-as-library \
  -I "$TMP_DIR" \
  -sdk "$SDK" \
  -target "$TARGET" \
  "$ROOT/AgentWorkbench/Sources/AgentWorkbenchApp/AgentWorkbenchApp.swift"

swiftc \
  -I "$TMP_DIR" \
  -L "$TMP_DIR" \
  -lAgentWorkbenchCore \
  -o "$TMP_DIR/AgentWorkbenchSmokeTest" \
  -sdk "$SDK" \
  -target "$TARGET" \
  "$ROOT/AgentWorkbench/Sources/AgentWorkbenchSmokeTest/main.swift"

DYLD_LIBRARY_PATH="$TMP_DIR" "$TMP_DIR/AgentWorkbenchSmokeTest" "$RUNS_ROOT"
printf '{"status":"passed","sdk":"%s","runsRoot":"%s"}\n' "$SDK" "$RUNS_ROOT"
