package domain

import "testing"

// Merge folds a turn into the running totals: input/output/total/cost add up
// across turns, while context fill is replaced by the latest turn's value.
func TestRunUsageMerge(t *testing.T) {
	first := (*RunUsage)(nil).Merge(&RunUsage{ContextTokens: 5000, InputTokens: 6000, OutputTokens: 70, TotalTokens: 6070, CostUSD: 0.12})
	if first.TotalTokens != 6070 || first.ContextTokens != 5000 {
		t.Fatalf("first turn = %+v", first)
	}

	second := first.Merge(&RunUsage{ContextTokens: 9000, InputTokens: 10000, OutputTokens: 100, TotalTokens: 10100, CostUSD: 0.20})
	if second.ContextTokens != 9000 {
		t.Errorf("ContextTokens = %d, want the latest turn's 9000", second.ContextTokens)
	}
	if second.TotalTokens != 16170 {
		t.Errorf("TotalTokens = %d, want accumulated 16170", second.TotalTokens)
	}
	if second.OutputTokens != 170 {
		t.Errorf("OutputTokens = %d, want accumulated 170", second.OutputTokens)
	}
	if second.CostUSD != 0.32 {
		t.Errorf("CostUSD = %v, want accumulated 0.32", second.CostUSD)
	}

	// Merging in a nil turn is a no-op; the original must be untouched.
	if got := second.Merge(nil); got != second {
		t.Errorf("Merge(nil) = %+v, want the receiver unchanged", got)
	}
}
