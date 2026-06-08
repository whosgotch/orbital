package app

import "github.com/whosgotch/orbital/worker/internal/store"

type Service struct {
	store *store.JSONStore
}

func NewService(store *store.JSONStore) *Service {
	return &Service{store: store}
}
