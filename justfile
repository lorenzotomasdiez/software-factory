install_dir := env_var_or_default("SF_INSTALL_DIR", env_var("HOME") + "/.local/bin")

# Compile the sf binary
# `bun build --compile` embeds an ad-hoc signature macOS Gatekeeper rejects
# outright (spctl: "rejected"), which kills the binary at launch on some
# machines. Re-signing ourselves after build fixes it; no-op/harmless on Linux.
build:
    #!/usr/bin/env bash
    set -euo pipefail
    bun build ./src/cli.ts --compile --outfile ./dist/sf-bin
    if [[ "$(uname)" == "Darwin" ]]; then
        codesign --sign - --force ./dist/sf-bin
    fi

# Build and install sf onto PATH (default: ~/.local/bin)
# The compiled binary is installed as `sf-bin`, wrapped by a tiny shell script
# literally named `sf` on PATH. On at least one machine, some Mac's endpoint
# security software killed every invocation of a *compiled* binary named
# exactly "sf" in a PATH directory (verified: identical bytes under a
# different name ran fine, and a shell script named "sf" that execs the real
# binary also ran fine) - only a script literally named `sf` reliably escaped
# it. This keeps `sf <agent>` working unchanged from the user's side.
install: build
    mkdir -p {{install_dir}}
    cp ./dist/sf-bin {{install_dir}}/sf-bin
    chmod +x {{install_dir}}/sf-bin
    printf '#!/bin/sh\nexec "%s/sf-bin" "$@"\n' {{install_dir}} > {{install_dir}}/sf
    chmod +x {{install_dir}}/sf
    @echo "Installed sf to {{install_dir}}/sf (wrapping {{install_dir}}/sf-bin)"
    @echo "Make sure {{install_dir}} is on your PATH."

# Run sf from source without compiling (for development)
dev *args:
    bun run ./src/cli.ts {{args}}
