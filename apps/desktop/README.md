# Orbital App

The app currently renders a worker-shaped mission fixture from `public/workerMissionFixture.json`.

## Refresh worker fixture

From `app/`, regenerate the demo repository, run the worker mission loop, and export the saved state:

```sh
npm run worker-fixture:refresh
```

To export the current saved worker state without resetting or running the demo again:

```sh
npm run worker-fixture:export
```

Both scripts use `/private/tmp/orbital-demo-repo` and write `public/workerMissionFixture.json`.

## Desktop shell

The app includes a Tauri v2 shell under `src-tauri/`.

```sh
npm run tauri:dev
```

Tauri commands require Rust and Cargo to be installed locally.
