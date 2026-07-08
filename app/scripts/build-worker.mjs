// Compiles the Go worker into src-tauri/binaries/ under the target-triple name
// Tauri's externalBin bundling expects. Triple defaults to the host; pass one
// explicitly when cross-compiling (CI): node scripts/build-worker.mjs <triple>
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

const triple = process.argv[2] ?? /host: (\S+)/.exec(execSync("rustc -vV", { encoding: "utf8" }))[1];
const goos = triple.includes("windows") ? "windows" : triple.includes("darwin") ? "darwin" : "linux";
const goarch = triple.startsWith("aarch64") ? "arm64" : "amd64";
const ext = goos === "windows" ? ".exe" : "";

const out = path.resolve(import.meta.dirname, "../src-tauri/binaries", `orbital-worker-${triple}${ext}`);
mkdirSync(path.dirname(out), { recursive: true });
execSync(`go build -o ${JSON.stringify(out)} ./cmd/orbital`, {
  cwd: path.resolve(import.meta.dirname, "../../worker"),
  stdio: "inherit",
  env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: "0" },
});
console.log(`worker sidecar: ${out}`);
