#!/usr/bin/env bash
# The full local gate — same checks CI runs (.github/workflows/ci.yml).
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== worker (Go)"
(cd worker && go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.12.2 run ./...)
(cd worker && go test ./...)

echo "== desktop (TypeScript)"
(cd apps/desktop && npm run lint)
(cd apps/desktop && npx tsc --noEmit)
(cd apps/desktop && npx vitest run)

echo "== desktop shell (Rust)"
(cd apps/desktop/src-tauri && cargo fmt --check)
(cd apps/desktop/src-tauri && cargo clippy --all-targets -- -D warnings)
(cd apps/desktop/src-tauri && cargo test)

echo "All checks passed."
