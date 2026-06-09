package app

import (
	"github.com/whosgotch/orbital/worker/internal/agent"
	"github.com/whosgotch/orbital/worker/internal/store"
)

type Service struct {
	store          *store.JSONStore
	workerRegistry *agent.WorkerRegistry
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
