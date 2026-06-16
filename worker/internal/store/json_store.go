package store

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
)

const stateFileName = "state.json"

type JSONStore struct {
	dir string
	mu  sync.Mutex
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
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := os.MkdirAll(s.dir, 0755); err != nil {
		return err
	}

	state.Normalize()
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}

	tempFile, err := os.CreateTemp(s.dir, "."+stateFileName+".*.tmp")
	if err != nil {
		return err
	}
	tempPath := tempFile.Name()
	defer os.Remove(tempPath)

	if _, err := tempFile.Write(data); err != nil {
		tempFile.Close()
		return err
	}
	if err := tempFile.Close(); err != nil {
		return err
	}

	return os.Rename(tempPath, s.StatePath())
}
