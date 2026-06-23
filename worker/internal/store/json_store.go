package store

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"syscall"
)

const stateFileName = "state.json"
const stateLockName = "state.lock"

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

// Update runs a read-modify-write transaction under a cross-process file lock,
// so several worker processes (one per parallel mission) can mutate the shared
// state without losing each other's writes. Reads via Load stay lock-free and
// always observe a complete snapshot thanks to the atomic rename in Save.
func (s *JSONStore) Update(mutate func(*State) error) (*State, error) {
	if err := os.MkdirAll(s.dir, 0755); err != nil {
		return nil, err
	}

	lockFile, err := os.OpenFile(filepath.Join(s.dir, stateLockName), os.O_CREATE|os.O_RDWR, 0644)
	if err != nil {
		return nil, err
	}
	defer lockFile.Close()

	if err := syscall.Flock(int(lockFile.Fd()), syscall.LOCK_EX); err != nil {
		return nil, err
	}
	defer syscall.Flock(int(lockFile.Fd()), syscall.LOCK_UN)

	state, err := s.Load()
	if err != nil {
		return nil, err
	}
	if err := mutate(state); err != nil {
		return nil, err
	}
	if err := s.Save(state); err != nil {
		return nil, err
	}

	return state, nil
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
