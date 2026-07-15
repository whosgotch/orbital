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
// plan for a goal, plus the tasks it proposes to carry it out. It anchors a
// plan node on the canvas; the human reviews the document and approves before
// the proposed tasks materialize as draft missions (linked back by PlanID).
type Plan struct {
	ID           string     `json:"id"`
	RepositoryID string     `json:"repository_id"`
	Goal         string     `json:"goal"`
	Format       PlanFormat `json:"format"`
	// Content is the rendered plan document, authored in Format.
	Content   string    `json:"content"`
	CreatedAt time.Time `json:"created_at"`
	// Subtasks are the tasks this plan proposes, materialized into draft
	// missions on approval. Empty once approval has consumed them onto the
	// canvas — ApprovedAt is what actually marks a plan approved.
	Subtasks []ProposedSubtask `json:"subtasks,omitempty"`
	// LinkableIDs is the graph-index resolution snapshot captured at plan time
	// (see graphIndexFor): entry n-1 is the real mission ID a subtask's basedOn
	// number n resolves to. Kept so approval — which can happen well after
	// planning — still resolves basedOn numbers correctly.
	LinkableIDs []string `json:"linkable_ids,omitempty"`
	// ApprovedAt is set once the human approves the plan and its subtasks
	// materialize into draft missions. Nil means still pending review.
	ApprovedAt *time.Time `json:"approved_at,omitempty"`
}

// ProposedSubtask is one task the planner carved the goal into. DependsOn
// holds indices of earlier sub-tasks that must land first, so the app can draw
// the same waits/parallel structure a human would by hand. BasedOn holds
// numbers of already-existing DONE nodes on the canvas (from the graph index
// handed to the planner) that this task builds on, empty when it stands alone.
type ProposedSubtask struct {
	Title     string `json:"title"`
	Text      string `json:"text"`
	DependsOn []int  `json:"dependsOn"`
	BasedOn   []int  `json:"basedOn"`
}
