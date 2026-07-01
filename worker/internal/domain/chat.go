package domain

import "time"

type ChatRole string

const (
	ChatRoleUser      ChatRole = "user"
	ChatRoleAssistant ChatRole = "assistant"
)

// ChatMessage is one turn in the conversation with an agent. The messages for a
// run, ordered by CreatedAt, are the live chat you steer that agent with — a
// user turn is an instruction you sent, an assistant turn is the agent's reply.
type ChatMessage struct {
	ID        string    `json:"id"`
	MissionID string    `json:"mission_id"`
	RunID     string    `json:"run_id"`
	Role      ChatRole  `json:"role"`
	Text      string    `json:"text"`
	CreatedAt time.Time `json:"created_at"`
}
