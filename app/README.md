# Orbital App

The app currently renders a worker-shaped mission fixture from `src/workerMissionFixture.json`.

## Refresh worker fixture

From `app/`, regenerate the demo repository, run the worker mission loop, and export the saved state:

```sh
npm run worker-fixture:refresh
```

To export the current saved worker state without resetting or running the demo again:

```sh
npm run worker-fixture:export
```

Both scripts use `/private/tmp/orbital-demo-repo` and write `src/workerMissionFixture.json`.
