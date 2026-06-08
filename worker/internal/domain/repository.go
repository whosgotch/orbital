package domain

import "time"

type Repository struct {
	ID        string    `json:"id"`
	Path      string    `json:"path"`
	Name      string    `json:"name"`
	Branch    string    `json:"branch"`
	CreatedAt time.Time `json:"created_at"`
}
