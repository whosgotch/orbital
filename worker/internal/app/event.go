package app

import (
	"fmt"
	"time"

	"github.com/whosgotch/orbital/worker/internal/domain"
)

func newWorkflowEvent(missionID string, runID string, eventType domain.WorkflowEventType, message string, command string, createdAt time.Time) domain.WorkflowEvent {
	return domain.WorkflowEvent{
		ID:        fmt.Sprintf("event_%d", createdAt.UnixNano()),
		MissionID: missionID,
		RunID:     runID,
		Type:      eventType,
		Message:   message,
		Command:   command,
		CreatedAt: createdAt,
	}
}
