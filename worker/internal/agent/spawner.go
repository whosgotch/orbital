package agent

import (
	"context"

	"github.com/whosgotch/orbital/worker/internal/domain"
)

// RunSpawner is implemented by the app.Service and injected into workers
// that need to coordinate child agents.
type RunSpawner interface {
	SpawnChildRun(ctx context.Context, parentRunID string, workerName string, task string) (*domain.AgentRun, error)
	MergePatches(runIDs []string) (*domain.PatchProposal, error)
}
