package app

import (
	"context"
	"io"

	"github.com/whosgotch/orbital/worker/internal/agent"
	"github.com/whosgotch/orbital/worker/internal/store"
)

// decomposeFunc breaks a mission outcome into operable sub-tasks. It's a field on
// the Service so tests can stub the decomposition without invoking the Claude CLI.
type decomposeFunc func(ctx context.Context, repoPath, mission string) ([]agent.SubTask, error)

type Service struct {
	store          *store.JSONStore
	workerRegistry *agent.WorkerRegistry
	eventOut       io.Writer
	decompose      decomposeFunc
}

func NewService(store *store.JSONStore) *Service {
	return &Service{
		store:          store,
		workerRegistry: agent.NewDefaultWorkerRegistry(),
		decompose:      agent.Decompose,
	}
}

func NewServiceWithWorkerRegistry(store *store.JSONStore, workerRegistry *agent.WorkerRegistry) *Service {
	return &Service{
		store:          store,
		workerRegistry: workerRegistry,
		decompose:      agent.Decompose,
	}
}

func (s *Service) SetEventOut(w io.Writer) {
	s.eventOut = w
}

func (s *Service) RegisterWorker(w agent.Worker) {
	s.workerRegistry.Register(w)
}
