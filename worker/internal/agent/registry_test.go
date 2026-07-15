package agent

import (
	"context"
	"testing"
)

// stubWorker is a minimal Worker used to exercise the registry.
type stubWorker struct{ name string }

func (w stubWorker) Name() string { return w.name }

func (w stubWorker) Profile() WorkerProfile { return WorkerProfile{Name: w.name} }

func (w stubWorker) CheckAvailable(context.Context) (*WorkerInfo, error) {
	return &WorkerInfo{Name: w.name, Available: true}, nil
}

func (w stubWorker) Supports(context.Context, RunRequest) SupportResult {
	return SupportResult{Supported: true}
}

func (w stubWorker) StartRun(context.Context, RunRequest) (<-chan RunEvent, error) {
	events := make(chan RunEvent)
	close(events)
	return events, nil
}

func (w stubWorker) CancelRun(context.Context, string) error { return nil }

func TestWorkerRegistryLooksUpRegisteredWorker(t *testing.T) {
	registry := NewWorkerRegistry()
	worker := stubWorker{name: "stub"}

	registry.Register(worker)

	got, err := registry.Lookup("stub")
	if err != nil {
		t.Fatalf("Lookup() error = %v", err)
	}

	if got != worker {
		t.Fatal("expected lookup to return registered worker")
	}
}

func TestWorkerRegistryRejectsUnknownWorker(t *testing.T) {
	registry := NewWorkerRegistry()

	if _, err := registry.Lookup("missing"); err == nil {
		t.Fatal("expected error for unknown worker, got nil")
	}
}
