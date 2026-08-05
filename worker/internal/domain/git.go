package domain

// GitSync is where the repo stands against its remote, for the commit gate's
// push control. Remote is "" when the repo has no remote at all (nothing to
// push to); Upstream is "" when the branch has one but has never been pushed,
// which is the "publish this branch" case.
type GitSync struct {
	Branch string `json:"branch"`
	// Head is the current short commit hash. The gate compares it against the
	// commit a mission landed to know whether that commit can still be amended.
	Head     string `json:"head"`
	Remote   string `json:"remote"`
	Upstream string `json:"upstream"`
	Ahead    int    `json:"ahead"`
	Behind   int    `json:"behind"`
}
