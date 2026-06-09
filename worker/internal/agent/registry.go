package agent

import "fmt"

type WorkerRegistry struct {
	workers map[string]Worker
}

func NewWorkerRegistry() *WorkerRegistry {
	return &WorkerRegistry{
		workers: make(map[string]Worker),
	}
}

func NewDefaultWorkerRegistry() *WorkerRegistry {
	registry := NewWorkerRegistry()
	registry.Register(NewMockWorker())
	return registry
}

func (r *WorkerRegistry) Register(worker Worker) {
	r.workers[worker.Name()] = worker
}

func (r *WorkerRegistry) Lookup(name string) (Worker, error) {
	worker, ok := r.workers[name]
	if !ok {
		return nil, fmt.Errorf("worker not found: %s", name)
	}

	return worker, nil
}
