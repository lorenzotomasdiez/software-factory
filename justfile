install_dir := env_var_or_default("SF_INSTALL_DIR", env_var("HOME") + "/.local/bin")

# Compile the sf binary
build:
    bun build ./src/cli.ts --compile --outfile ./dist/sf

# Build and install sf onto PATH (default: ~/.local/bin)
install: build
    mkdir -p {{install_dir}}
    cp ./dist/sf {{install_dir}}/sf
    chmod +x {{install_dir}}/sf
    @echo "Installed sf to {{install_dir}}/sf"
    @echo "Make sure {{install_dir}} is on your PATH."

# Run sf from source without compiling (for development)
dev *args:
    bun run ./src/cli.ts {{args}}
