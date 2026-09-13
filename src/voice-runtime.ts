import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT_DIR } from "./home";
import lockText from "../voice-runtime/uv.lock" with { type: "text" };
import projectText from "../voice-runtime/pyproject.toml" with { type: "text" };
import serverText from "../voice-runtime/server.py" with { type: "text" };

export const KOKORO_PORT = 49637;
const KOKORO_URL = `http://127.0.0.1:${KOKORO_PORT}/v1/audio/speech`;
const VOICE_RUNTIME_DIR = join(ROOT_DIR, "voice-runtime");
const MODEL_DIR = join(VOICE_RUNTIME_DIR, "models");
const MODEL_FILE = join(MODEL_DIR, "kokoro-v1.0.int8.onnx");
const VOICES_FILE = join(MODEL_DIR, "voices-v1.0.bin");
const UV_VERSION = "0.12.13";
const UV_DIR = join(VOICE_RUNTIME_DIR, "bin");
const UV_TARGETS: Record<string, { archive: string; sha256: string; folder: string }> = {
  "darwin-arm64": {
    archive: "uv-aarch64-apple-darwin.tar.gz",
    sha256: "7e6ddb9316acc00f2296c82ff4d99977870ee34b2f0ddcae9444d714db9364ed",
    folder: "uv-aarch64-apple-darwin",
  },
  "darwin-x64": {
    archive: "uv-x86_64-apple-darwin.tar.gz",
    sha256: "5e287ef61cb6a9b61b3a83fef124fd143e400468a7dac794230147a810e17119",
    folder: "uv-x86_64-apple-darwin",
  },
  "linux-arm64": {
    archive: "uv-aarch64-unknown-linux-gnu.tar.gz",
    sha256: "2eaa5d94f5db7b3a1a092156b9420459e42ab0217d917fe74a876309cef9b5e9",
    folder: "uv-aarch64-unknown-linux-gnu",
  },
  "linux-x64": {
    archive: "uv-x86_64-unknown-linux-gnu.tar.gz",
    sha256: "745765a3b6e360ad76743599ae5c42e9278c7edf8bbff9fc76d05bf2623a04dd",
    folder: "uv-x86_64-unknown-linux-gnu",
  },
};

const ASSETS = [
  {
    path: MODEL_FILE,
    url: "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/kokoro-v1.0.int8.onnx",
    sha256: "ae315a79b623f244700e4afb9246c46a26066782e049ba174bf3ba433970ee9c",
    size: 114119327,
  },
  {
    path: VOICES_FILE,
    url: "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/voices-v1.0.bin",
    sha256: "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d",
    size: 28214398,
  },
] as const;

export interface VoiceRuntimeHandle {
  url: string;
  stop(): Promise<void>;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isVerifiedFile(asset: (typeof ASSETS)[number]): boolean {
  try {
    return readFileSync(asset.path).byteLength === asset.size && sha256(asset.path) === asset.sha256;
  } catch {
    return false;
  }
}

async function downloadVerified(asset: (typeof ASSETS)[number]): Promise<void> {
  if (isVerifiedFile(asset)) return;
  try {
    unlinkSync(asset.path);
  } catch {
    // The file may not exist yet.
  }

  const response = await fetch(asset.url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Kokoro download failed (${response.status}): ${asset.url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== asset.size || digest !== asset.sha256) {
    throw new Error(`Kokoro download checksum mismatch: ${asset.url}`);
  }

  const temp = `${asset.path}.${randomUUID()}.tmp`;
  writeFileSync(temp, bytes, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, asset.path);
}

async function resolveUv(): Promise<string> {
  const systemUv = Bun.which("uv");
  if (systemUv) return systemUv;

  const target = UV_TARGETS[`${process.platform}-${process.arch}`];
  if (!target) throw new Error(`voice-only cannot bootstrap uv on ${process.platform}/${process.arch}`);
  const bundledUv = join(UV_DIR, "uv");
  if (existsSync(bundledUv)) return bundledUv;
  const tar = Bun.which("tar");
  if (!tar) throw new Error("voice-only requires tar to bootstrap its verified local runtime");

  mkdirSync(UV_DIR, { recursive: true, mode: 0o700 });
  const archiveUrl = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${target.archive}`;
  const response = await fetch(archiveUrl, { redirect: "follow" });
  if (!response.ok) throw new Error(`uv download failed (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== target.sha256) throw new Error("uv download checksum mismatch");

  const tempDir = join(UV_DIR, `extract-${randomUUID()}`);
  const tempArchive = join(UV_DIR, `${randomUUID()}.tar.gz`);
  mkdirSync(tempDir, { recursive: true, mode: 0o700 });
  writeFileSync(tempArchive, bytes, { mode: 0o600 });
  try {
    const extraction = Bun.spawn([tar, "-xzf", tempArchive, "-C", tempDir], { stdout: "ignore", stderr: "pipe" });
    if (await extraction.exited !== 0) throw new Error("uv archive extraction failed");
    const extractedUv = join(tempDir, target.folder, "uv");
    if (!existsSync(extractedUv)) throw new Error("uv archive did not contain the expected executable");
    renameSync(extractedUv, bundledUv);
    chmodSync(bundledUv, 0o700);
  } finally {
    try { unlinkSync(tempArchive); } catch { /* already removed */ }
    rmSync(tempDir, { recursive: true, force: true });
  }
  return bundledUv;
}

function materializeRuntime(): void {
  mkdirSync(MODEL_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(VOICE_RUNTIME_DIR, { recursive: true, mode: 0o700 });
  chmodSync(MODEL_DIR, 0o700);
  chmodSync(VOICE_RUNTIME_DIR, 0o700);
  writeFileSync(join(VOICE_RUNTIME_DIR, "pyproject.toml"), projectText, { mode: 0o600 });
  writeFileSync(join(VOICE_RUNTIME_DIR, "uv.lock"), lockText, { mode: 0o600 });
  writeFileSync(join(VOICE_RUNTIME_DIR, "server.py"), serverText, { mode: 0o600 });
}

async function waitForReady(proc: Bun.Subprocess, url: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (proc.exitCode !== null) throw new Error(`Kokoro exited during startup (${proc.exitCode})`);
    try {
      const response = await fetch(url.replace("/v1/audio/speech", "/healthz"), {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {
      // The model can take several seconds to load.
    }
    await Bun.sleep(500);
  }
  proc.kill();
  throw new Error("Kokoro did not become ready within 60 seconds");
}

/** Starts the pinned local Kokoro runtime. Explicit user endpoints/commands win. */
export async function startVoiceRuntime(): Promise<VoiceRuntimeHandle | undefined> {
  if (process.env.SF_KOKORO_URL || process.env.SF_KOKORO_COMMAND) return undefined;

  const uv = await resolveUv();
  materializeRuntime();
  for (const asset of ASSETS) await downloadVerified(asset);

  const proc = Bun.spawn(
    [uv, "--no-config", "run", "--locked", "--project", VOICE_RUNTIME_DIR, "--python", "3.12", "server.py"],
    {
      cwd: VOICE_RUNTIME_DIR,
      stdout: "ignore",
      stderr: "inherit",
      env: {
        ...process.env,
        SF_KOKORO_PORT: String(KOKORO_PORT),
        SF_KOKORO_MODEL_PATH: MODEL_FILE,
        SF_KOKORO_VOICES_PATH: VOICES_FILE,
        SF_KOKORO_VOICE: process.env.SF_KOKORO_VOICE || "af_heart",
      },
    },
  );

  try {
    await waitForReady(proc, KOKORO_URL);
  } catch (error) {
    proc.kill();
    await proc.exited;
    throw error;
  }

  return {
    url: KOKORO_URL,
    async stop() {
      if (proc.exitCode === null) {
        try {
          await fetch(`${KOKORO_URL.replace("/v1/audio/speech", "/shutdown")}`, {
            method: "POST",
            signal: AbortSignal.timeout(1000),
          });
        } catch {
          // Fall back to terminating the process if the server is unhealthy.
        }
        await Promise.race([proc.exited, Bun.sleep(3000)]);
        if (proc.exitCode === null) proc.kill();
        await proc.exited;
      }
    },
  };
}
