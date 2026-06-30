package app

import (
	"io"
	"sync"

	"github.com/whosgotch/orbital/worker/internal/agent"
	"github.com/whosgotch/orbital/worker/internal/store"
)

type Service struct {
	store          *store.JSONStore
	workerRegistry *agent.WorkerRegistry
	eventOut       io.Writer
	// streamMu serializes writes to eventOut, and worktreeMu serializes git
	// worktree creation, so the parallel child agents an AI manager spawns don't
	// corrupt the NDJSON event stream or race `git worktree add`.
	streamMu   sync.Mutex
	worktreeMu sync.Mutex
}

func NewService(store *store.JSONStore) *Service {
	return &Service{
		store:          store,
		workerRegistry: agent.NewDefaultWorkerRegistry(),
	}
}

func NewServiceWithWorkerRegistry(store *store.JSONStore, workerRegistry *agent.WorkerRegistry) *Service {
	return &Service{
		store:          store,
		workerRegistry: workerRegistry,
	}
}

func (s *Service) SetEventOut(w io.Writer) {
	s.eventOut = w
}

func (s *Service) RegisterWorker(w agent.Worker) {
	s.workerRegistry.Register(w)
}
