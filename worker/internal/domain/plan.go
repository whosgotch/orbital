package domain

import "time"

// PlanFormat is how a plan document is authored and displayed. The AI writes the
// plan in this format, so html/md/text genuinely read differently rather than
// being one source shown three ways.
type PlanFormat string

const (
	PlanFormatMarkdown PlanFormat = "md"
	PlanFormatHTML     PlanFormat = "html"
	PlanFormatText     PlanFormat = "text"
)

// Plan is the outcome of a repo-level planning conversation: the AI's written
// plan for a goal, plus the task missions it proposes (linked back by PlanID).
// It anchors a plan node on the canvas that fans out to those tasks.
type Plan struct {
	ID           string     `json:"id"`
	RepositoryID string     `json:"repository_id"`
	Goal         string     `json:"goal"`
	Format       PlanFormat `json:"format"`
	// Content is the rendered plan document, authored in Format.
	Content   string    `json:"content"`
	CreatedAt time.Time `json:"created_at"`
}
