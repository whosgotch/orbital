#!/usr/bin/env bash
# The full local gate — same checks CI runs (.github/workflows/ci.yml).
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== worker (Go)"
(cd worker && go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.12.2 run ./...)
(cd worker && go test ./...)

echo "== desktop (TypeScript)"
(cd app && npm run lint)
(cd app && npx tsc --noEmit)
(cd app && npx vitest run)

echo "== desktop shell (Rust)"
(cd app/src-tauri && cargo fmt --check)
(cd app/src-tauri && cargo clippy --all-targets -- -D warnings)
(cd app/src-tauri && cargo test)

echo "All checks passed."
