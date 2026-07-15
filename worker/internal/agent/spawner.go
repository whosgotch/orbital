package agent

import (
	"context"

	"github.com/whosgotch/orbital/worker/internal/domain"
)

// RunSpawner is implemented by the app.Service and injected into workers
// that need to coordinate child agents.
//
// Intentionally parked: the child-run / AI-manager machinery (SpawnChildRun,
// MergePatches, ListChildRuns) is kept for future visible-node decomposition
// and is not exercised by the live single-engineer path today.
type RunSpawner interface {
	SpawnChildRun(ctx context.Context, parentRunID string, workerName string, task string) (*domain.AgentRun, error)
	MergePatches(runIDs []string) (*domain.PatchProposal, error)
}
