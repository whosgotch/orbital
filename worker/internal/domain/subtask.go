package domain

// ProposedSubtask is one task the extractor carved a research document's
// findings into. DependsOn holds indices of earlier sub-tasks in the same
// batch that must land first, so the app can draw the same waits/parallel
// structure a human would by hand. BasedOn holds numbers of already-existing
// DONE nodes on the canvas (from the graph index handed to the extractor)
// that this task builds on, empty when it stands alone.
type ProposedSubtask struct {
	Title     string `json:"title"`
	Text      string `json:"text"`
	DependsOn []int  `json:"dependsOn"`
	BasedOn   []int  `json:"basedOn"`
}
