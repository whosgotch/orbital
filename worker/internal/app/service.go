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
	// runModel is the claude model every run this process starts should use
	// (one CLI invocation = one run), stamped onto each RunRequest — including
	// the child runs an AI manager spawns. Empty means the CLI default.
	runModel string
	// runEffort is the model's thinking level (--effort) every run this process
	// starts should use, stamped onto each RunRequest. Empty means the CLI default.
	runEffort string
	// streamMu serializes writes to eventOut, and worktreeMu serializes git
	// worktree creation, so the parallel child agents an AI manager spawns don't
	// corrupt the NDJSON event stream or race `git worktree add`.
	streamMu   sync.Mutex
	worktreeMu sync.Mutex
}

func NewService(store *store.JSONStore) *Service {
	return &Service{
		store:          store,
		workerRegistry: agent.NewWorkerRegistry(),
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

func (s *Service) SetRunModel(model string) {
	s.runModel = model
}

func (s *Service) SetRunEffort(effort string) {
	s.runEffort = effort
}

func (s *Service) RegisterWorker(w agent.Worker) {
	s.workerRegistry.Register(w)
}
