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
	// streamMu serializes writes to eventOut, and worktreeMu serializes git
	// worktree creation, so the parallel child agents an AI manager spawns don't
	// corrupt the NDJSON event stream or race `git worktree add`.
	streamMu   sync.Mutex
	worktreeMu sync.Mutex
	// decompose breaks a task into sub-tasks; nil uses the claude-backed default.
	// Overridable so DecomposeMission is testable without the CLI.
	decompose decomposeFunc
	// plan produces a repo-level plan; nil uses the claude-backed default.
	// Overridable so PlanRepo is testable without the CLI.
	plan planFunc
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

func (s *Service) SetRunModel(model string) {
	s.runModel = model
}

func (s *Service) RegisterWorker(w agent.Worker) {
	s.workerRegistry.Register(w)
}

// SetDecomposer overrides how a task is broken into sub-tasks (tests inject a
// deterministic one instead of the claude CLI).
func (s *Service) SetDecomposer(fn decomposeFunc) {
	s.decompose = fn
}

// SetPlanner overrides how a repo is planned (tests inject a deterministic one
// instead of the claude CLI).
func (s *Service) SetPlanner(fn planFunc) {
	s.plan = fn
}
