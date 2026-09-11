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
# security software killed invocations of a *compiled* binary at a PATH
# location whose bytes had just been overwritten in place - reinstalling
# repeatedly during development (cp over the same path each time) reliably
# triggered it, while installing once to a fresh path never did. `install`
# therefore writes to a fresh temp path and atomically renames into place,
# so a reinstall never overwrites bytes at an already-executed path.
install: build
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p {{install_dir}}
    tmp_bin="{{install_dir}}/.sf-bin.$$"
    tmp_wrapper="{{install_dir}}/.sf.$$"
    cp ./dist/sf-bin "$tmp_bin"
    chmod +x "$tmp_bin"
    mv -f "$tmp_bin" {{install_dir}}/sf-bin
    printf '#!/bin/sh\nexec "%s/sf-bin" "$@"\n' {{install_dir}} > "$tmp_wrapper"
    chmod +x "$tmp_wrapper"
    mv -f "$tmp_wrapper" {{install_dir}}/sf
    echo "Installed sf to {{install_dir}}/sf (wrapping {{install_dir}}/sf-bin)"
    echo "Make sure {{install_dir}} is on your PATH."

# Run sf from source without compiling (for development)
dev *args:
    bun run ./src/cli.ts {{args}}
