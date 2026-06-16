package agent

import "testing"

func TestWorkerRegistryLooksUpRegisteredWorker(t *testing.T) {
	registry := NewWorkerRegistry()
	worker := NewMockWorker()

	registry.Register(worker)

	got, err := registry.Lookup("mock")
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

func TestDefaultWorkerRegistryIncludesMockWorker(t *testing.T) {
	registry := NewDefaultWorkerRegistry()

	worker, err := registry.Lookup("mock")
	if err != nil {
		t.Fatalf("Lookup() error = %v", err)
	}

	if worker.Name() != "mock" {
		t.Fatalf("worker name = %q, want %q", worker.Name(), "mock")
	}

	if worker.Profile().Mode != "demo" {
		t.Fatalf("worker mode = %q, want %q", worker.Profile().Mode, "demo")
	}
}
