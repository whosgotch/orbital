package main

import "github.com/whosgotch/orbital/worker/internal/agent/agenttest"

// Register the mock worker for CLI tests only. It stands in for a real AI
// worker so start-run/approve/reject/verify can be exercised end-to-end with a
// deterministic patch. Production builds never see it (testWorkers is empty).
func init() {
	testWorkers = append(testWorkers, agenttest.NewMockWorker())
}
