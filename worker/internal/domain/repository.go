package domain

import "time"

type Repository struct {
	ID                  string    `json:"id"`
	Path                string    `json:"path"`
	Name                string    `json:"name"`
	Branch              string    `json:"branch"`
	VerificationCommand string    `json:"verification_command"`
	CreatedAt           time.Time `json:"created_at"`
}
