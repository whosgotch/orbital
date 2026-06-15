package store

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

const stateFileName = "state.json"

type JSONStore struct {
	dir string
}

func NewJSONStore(dir string) *JSONStore {
	return &JSONStore{dir: dir}
}

func (s *JSONStore) StatePath() string {
	return filepath.Join(s.dir, stateFileName)
}

func (s *JSONStore) Load() (*State, error) {
	data, err := os.ReadFile(s.StatePath())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			state := &State{}
			state.Normalize()
			return state, nil
		}

		return nil, err
	}

	var state State
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, err
	}
	state.Normalize()

	return &state, nil
}

func (s *JSONStore) Save(state *State) error {
	if err := os.MkdirAll(s.dir, 0755); err != nil {
		return err
	}

	state.Normalize()
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(s.StatePath(), data, 0644)
}
