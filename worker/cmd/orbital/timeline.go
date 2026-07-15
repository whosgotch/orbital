package main

import (
	"fmt"
	"io"

	"github.com/whosgotch/orbital/worker/internal/domain"
)

func printTimeline(stdout io.Writer, events []domain.WorkflowEvent) {
	if len(events) == 0 {
		return
	}

	_, _ = fmt.Fprintln(stdout, "timeline:")
	for _, event := range events {
		_, _ = fmt.Fprintf(stdout, "- %s: %s\n", event.Type, event.Message)
	}
}
