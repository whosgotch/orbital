package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"time"
)

// modelInfo is what the app's model picker renders: the id is passed to
// `claude --model`, the display name is what the user sees.
type modelInfo struct {
	ID          string `json:"id"`
	DisplayName string `json:"display_name"`
}

// listModels prints every model available in the provider as JSON. With an
// ANTHROPIC_API_KEY it queries the live Models API (GET /v1/models); without
// one — the common case when the claude CLI authenticates via subscription —
// it falls back to the current known model catalog, so the picker always has
// the full lineup.
func listModels(args []string, stdout io.Writer) error {
	if len(args) != 2 {
		return usageError()
	}

	models := fetchProviderModels()
	if len(models) == 0 {
		models = fallbackModels()
	}

	data, err := json.Marshal(models)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(stdout, string(data))
	return err
}

// fetchProviderModels pages through GET /v1/models. Any failure returns nil so
// the caller falls back to the static catalog instead of surfacing an error —
// the picker should never break the app.
func fetchProviderModels() []modelInfo {
	apiKey := os.Getenv("ANTHROPIC_API_KEY")
	if apiKey == "" {
		return nil
	}

	client := &http.Client{Timeout: 8 * time.Second}
	var models []modelInfo
	afterID := ""

	for {
		endpoint := "https://api.anthropic.com/v1/models?limit=100"
		if afterID != "" {
			endpoint += "&after_id=" + url.QueryEscape(afterID)
		}

		req, err := http.NewRequest(http.MethodGet, endpoint, nil)
		if err != nil {
			return nil
		}
		req.Header.Set("x-api-key", apiKey)
		req.Header.Set("anthropic-version", "2023-06-01")

		resp, err := client.Do(req)
		if err != nil {
			return nil
		}

		var page struct {
			Data    []modelInfo `json:"data"`
			HasMore bool        `json:"has_more"`
			LastID  string      `json:"last_id"`
		}
		decodeErr := json.NewDecoder(resp.Body).Decode(&page)
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusOK || decodeErr != nil {
			return nil
		}

		models = append(models, page.Data...)
		if !page.HasMore || page.LastID == "" {
			break
		}
		afterID = page.LastID
	}

	return models
}

// fallbackModels is the current model catalog, newest tiers first. IDs are the
// exact aliases the claude CLI accepts via --model.
func fallbackModels() []modelInfo {
	return []modelInfo{
		{ID: "claude-opus-4-8", DisplayName: "Claude Opus 4.8"},
		{ID: "claude-opus-4-7", DisplayName: "Claude Opus 4.7"},
		{ID: "claude-opus-4-6", DisplayName: "Claude Opus 4.6"},
		{ID: "claude-sonnet-5", DisplayName: "Claude Sonnet 5"},
		{ID: "claude-sonnet-4-6", DisplayName: "Claude Sonnet 4.6"},
		{ID: "claude-haiku-4-5", DisplayName: "Claude Haiku 4.5"},
	}
}
