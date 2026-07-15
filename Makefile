.PHONY: lint test check

GOLANGCI_LINT_VERSION := v2.12.2

lint:
	cd worker && go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@$(GOLANGCI_LINT_VERSION) run ./...
	cd apps/desktop && npm run lint
	cd apps/desktop && npx tsc --noEmit
	cd apps/desktop/src-tauri && cargo fmt --check
	cd apps/desktop/src-tauri && cargo clippy --all-targets -- -D warnings

test:
	cd worker && go test ./...
	cd apps/desktop && npx vitest run
	cd apps/desktop/src-tauri && cargo test

check: lint test
