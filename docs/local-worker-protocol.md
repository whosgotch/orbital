# Local Worker Protocol

`local-command` lets Orbital run an external process from the repository root and fold the result back into the mission loop.

## Run Command

```sh
orbital start-run <repo-path> <mission-id> \
  --worker local-command \
  --command "<your command>"
```

When using the desktop app, choose `Local command` in the work order and edit the command field.

## Environment

Orbital sets these environment variables for the local worker process:

```text
ORBITAL_RUN_ID
ORBITAL_MISSION_ID
ORBITAL_REPO_PATH
ORBITAL_MISSION_TEXT
ORBITAL_PATCH_PATH
```

The process runs with its working directory set to `ORBITAL_REPO_PATH`.

## Exit Behavior

- Exit code `0`: the run completes.
- Non-zero exit code: the run is marked failed.
- Stdout and stderr are captured into the mission activity stream. Output is bounded before being stored in state.

## Patch Artifact

To propose a patch, write a unified diff to:

```sh
$ORBITAL_PATCH_PATH
```

Orbital expects a diff that `git apply` can consume from the repository root.

If `ORBITAL_PATCH_PATH` is missing or empty, the run completes without a patch proposal. If it contains a diff, Orbital creates a pending patch proposal and moves the mission to human review.

## Minimal Example

```sh
printf 'diff --git a/orbital-local-worker.txt b/orbital-local-worker.txt
new file mode 100644
--- /dev/null
+++ b/orbital-local-worker.txt
@@ -0,0 +1 @@
+local worker completed
' > "$ORBITAL_PATCH_PATH"
```

After the run completes, approve the patch through the app or CLI:

```sh
orbital approve <repo-path> <mission-id>
```
