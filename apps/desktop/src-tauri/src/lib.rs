use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, State};

/// Tracks the OS process group id of every in-flight agent run, keyed by
/// mission id, so a delete can shut the live agent down. Each run is spawned as
/// its own process-group leader (see `run_worker_streaming`), so killing the
/// group tears down the whole tree: the worker binary and any `claude`/`git`
/// children it spawns.
#[derive(Default, Clone)]
struct RunningRuns(Arc<Mutex<HashMap<String, u32>>>);

/// Removes a mission's registry entry when the run finishes, however it ends
/// (normal completion, error, or being killed by a delete).
struct RunGuard {
    runs: RunningRuns,
    mission_id: String,
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        if let Ok(mut map) = self.runs.0.lock() {
            map.remove(&self.mission_id);
        }
    }
}

// Shared verbatim with the frontend's demoRepoPath and the npm fixture
// scripts; change all three together.
const DEMO_REPO_PATH: &str = "/private/tmp/orbital-demo-repo";
const DEMO_VERIFICATION_COMMAND: &str = "node -e \"console.log('verified')\"";

/// Compiled worker binary, built once per app launch. Every command then execs
/// the binary directly instead of paying `go run`'s compile-and-link check on
/// each invocation — the difference between a snappy canvas and dead air.
/// Failures are not cached, so a broken build is retried on the next call.
static WORKER_BINARY: Mutex<Option<PathBuf>> = Mutex::new(None);

fn worker_binary() -> Result<PathBuf, String> {
    let mut cached = WORKER_BINARY
        .lock()
        .map_err(|_| "worker binary lock poisoned".to_string())?;
    if let Some(path) = cached.as_ref() {
        return Ok(path.clone());
    }

    // Resolution order: explicit override, the sidecar shipped next to the app
    // executable (bundled builds), then compiling from source (dev checkout).
    let bin = if let Ok(path) = std::env::var("ORBITAL_WORKER") {
        PathBuf::from(path)
    } else if let Some(sidecar) = sidecar_worker() {
        sidecar
    } else {
        build_worker_from_source()?
    };

    *cached = Some(bin.clone());
    Ok(bin)
}

fn sidecar_worker() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let sidecar = exe
        .parent()?
        .join(format!("orbital-worker{}", std::env::consts::EXE_SUFFIX));
    sidecar.exists().then_some(sidecar)
}

fn build_worker_from_source() -> Result<PathBuf, String> {
    let bin = std::env::temp_dir().join(format!("orbital-worker{}", std::env::consts::EXE_SUFFIX));
    let output = Command::new("go")
        .args(["build", "-o"])
        .arg(&bin)
        .arg("./cmd/orbital")
        .current_dir(worker_dir()?)
        .env("GOCACHE", std::env::temp_dir().join("orbital-go-cache"))
        .output()
        .map_err(|error| format!("failed to build worker: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("go build exited with status {}", output.status)
        } else {
            stderr
        });
    }

    Ok(bin)
}

#[tauri::command]
fn load_worker_state(repo_path: Option<String>) -> Result<String, String> {
    let repo_path = repo_path.unwrap_or_else(|| DEMO_REPO_PATH.to_string());
    run_worker_status(repo_path.trim())
}

#[tauri::command]
fn refresh_demo_worker_loop() -> Result<String, String> {
    run_worker(&["demo-fixture", DEMO_REPO_PATH])?;
    run_worker(&[
        "run",
        DEMO_REPO_PATH,
        "add a version command",
        DEMO_VERIFICATION_COMMAND,
    ])?;
    run_worker_status(DEMO_REPO_PATH)
}

#[tauri::command]
fn open_repository(repo_path: String) -> Result<String, String> {
    run_worker(&["open", repo_path.trim()])
}

#[tauri::command]
fn queue_mission(
    repo_path: String,
    mission_text: String,
    campaign_id: Option<String>,
    tool_command: Option<String>,
) -> Result<String, String> {
    let mut args = vec!["queue", repo_path.trim(), mission_text.trim()];
    if let Some(id) = campaign_id.as_deref().map(str::trim).filter(|id| !id.is_empty()) {
        args.extend(["--campaign", id]);
    }
    if let Some(cmd) = tool_command.as_deref().map(str::trim).filter(|cmd| !cmd.is_empty()) {
        args.extend(["--tool", cmd]);
    }
    run_worker(&args)
}

#[tauri::command]
async fn start_agent_run(
    app: tauri::AppHandle,
    runs: State<'_, RunningRuns>,
    repo_path: String,
    mission_id: String,
    worker_name: Option<String>,
    command: Option<String>,
    model: Option<String>,
) -> Result<String, String> {
    let worker_name = worker_name.unwrap_or_else(|| "mock".to_string());
    let mut args: Vec<String> = if worker_name.trim() == "local-command" {
        let cmd = command.unwrap_or_default();
        vec![
            "start-run".into(),
            repo_path.trim().to_string(),
            mission_id.trim().to_string(),
            "--worker".into(),
            "local-command".into(),
            "--command".into(),
            cmd.trim().to_string(),
        ]
    } else {
        vec![
            "start-run".into(),
            repo_path.trim().to_string(),
            mission_id.trim().to_string(),
            "--worker".into(),
            worker_name.trim().to_string(),
        ]
    };
    if let Some(model) = model.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
        args.extend(["--model".into(), model.to_string()]);
    }

    let runs = runs.inner().clone();
    let mission_id = mission_id.trim().to_string();

    // Run the blocking worker off the main thread so the UI stays responsive
    // while events stream in over the ~minute the run takes.
    tauri::async_runtime::spawn_blocking(move || {
        let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        run_worker_streaming(&app, &runs, &mission_id, &arg_refs)
    })
    .await
    .map_err(|e| format!("worker task failed: {e}"))?
}

#[tauri::command]
async fn send_agent_message(
    app: tauri::AppHandle,
    runs: State<'_, RunningRuns>,
    repo_path: String,
    mission_id: String,
    text: String,
    model: Option<String>,
) -> Result<String, String> {
    let mut args: Vec<String> = vec![
        "send-message".into(),
        repo_path.trim().to_string(),
        mission_id.trim().to_string(),
        text.to_string(),
    ];
    if let Some(model) = model.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
        args.extend(["--model".into(), model.to_string()]);
    }

    let runs = runs.inner().clone();
    let mission_id = mission_id.trim().to_string();

    // A chat turn streams the agent's work just like a run; keep it off the main
    // thread so the UI stays responsive while the agent thinks and edits.
    tauri::async_runtime::spawn_blocking(move || {
        let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        run_worker_streaming(&app, &runs, &mission_id, &arg_refs)
    })
    .await
    .map_err(|e| format!("worker task failed: {e}"))?
}

#[tauri::command]
fn update_mission_text(
    repo_path: String,
    mission_id: String,
    text: String,
) -> Result<String, String> {
    run_worker(&["edit-mission", repo_path.trim(), mission_id.trim(), text.trim()])
}

#[tauri::command]
fn delete_mission(
    runs: State<'_, RunningRuns>,
    repo_path: String,
    mission_id: String,
) -> Result<String, String> {
    let mission_id = mission_id.trim();

    // Shut the live agent down first so it can't keep writing to the worktree
    // we're about to remove. The streaming task's RunGuard clears the registry
    // entry once the killed process is reaped.
    let pgid = runs.0.lock().ok().and_then(|map| map.get(mission_id).copied());
    if let Some(pgid) = pgid {
        kill_process_group(pgid);
    }

    run_worker(&["delete", repo_path.trim(), mission_id])
}

/// Terminates a process group: SIGTERM to let `claude`/`git` unwind, then
/// SIGKILL as a fallback for anything that ignored it. A negative pid targets
/// the whole group, which is why agent runs are spawned as group leaders.
#[cfg(unix)]
fn kill_process_group(pgid: u32) {
    let _ = Command::new("kill").arg("-TERM").arg(format!("-{pgid}")).status();
    std::thread::sleep(std::time::Duration::from_millis(400));
    let _ = Command::new("kill").arg("-KILL").arg(format!("-{pgid}")).status();
}

#[cfg(not(unix))]
fn kill_process_group(pgid: u32) {
    let _ = Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pgid.to_string()])
        .status();
}

#[tauri::command]
fn list_models() -> Result<String, String> {
    run_worker(&["models"])
}

#[tauri::command]
fn load_repo_history(repo_path: String) -> Result<String, String> {
    run_worker(&["history", "--json", repo_path.trim()])
}

#[tauri::command]
fn load_commit_diff(repo_path: String, hash: String) -> Result<String, String> {
    run_worker(&["show", repo_path.trim(), hash.trim()])
}

#[tauri::command]
fn link_missions(repo_path: String, from_mission_id: String, to_mission_id: String) -> Result<String, String> {
    run_worker(&["link", repo_path.trim(), from_mission_id.trim(), to_mission_id.trim()])
}

#[tauri::command]
fn unlink_missions(repo_path: String, from_mission_id: String, to_mission_id: String) -> Result<String, String> {
    run_worker(&["unlink", repo_path.trim(), from_mission_id.trim(), to_mission_id.trim()])
}

#[tauri::command]
async fn plan_repo(
    repo_path: String,
    goal: String,
    format: Option<String>,
    model: Option<String>,
) -> Result<String, String> {
    let format = format.unwrap_or_else(|| "md".to_string());
    let model = model.unwrap_or_default();
    let args: Vec<String> = vec![
        "plan".into(),
        repo_path.trim().to_string(),
        goal.trim().to_string(),
        "--format".into(),
        format.trim().to_string(),
        "--model".into(),
        model.trim().to_string(),
    ];

    // Planning reads the repo with `claude`, which can take a while; keep it off
    // the main thread so the app stays responsive while it explores and plans.
    tauri::async_runtime::spawn_blocking(move || {
        let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        run_worker(&arg_refs)
    })
    .await
    .map_err(|e| format!("worker task failed: {e}"))?
}

#[tauri::command]
async fn decompose_mission(repo_path: String, mission_id: String, model: Option<String>) -> Result<String, String> {
    let model = model.unwrap_or_default();
    let args: Vec<String> = vec![
        "decompose".into(),
        repo_path.trim().to_string(),
        mission_id.trim().to_string(),
        "--model".into(),
        model.trim().to_string(),
    ];

    // Decomposition shells out to `claude`, which can take several seconds; keep
    // it off the main thread so the whole app doesn't freeze while it thinks.
    tauri::async_runtime::spawn_blocking(move || {
        let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        run_worker(&arg_refs)
    })
    .await
    .map_err(|e| format!("worker task failed: {e}"))?
}

#[tauri::command]
fn approve_patch(repo_path: String, mission_id: String) -> Result<String, String> {
    run_worker(&["approve", repo_path.trim(), mission_id.trim()])
}

#[tauri::command]
fn reject_patch(repo_path: String, mission_id: String) -> Result<String, String> {
    run_worker(&["reject", repo_path.trim(), mission_id.trim()])
}

#[tauri::command]
fn verify_mission(
    repo_path: String,
    mission_id: String,
    command: Option<String>,
) -> Result<String, String> {
    let command = command.unwrap_or_else(|| DEMO_VERIFICATION_COMMAND.to_string());
    run_worker(&[
        "verify",
        repo_path.trim(),
        mission_id.trim(),
        command.trim(),
    ])
}

fn run_worker_streaming(
    app: &tauri::AppHandle,
    runs: &RunningRuns,
    mission_id: &str,
    args: &[&str],
) -> Result<String, String> {
    let mut command = Command::new(worker_binary()?);
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Put the run in its own process group so a delete can kill the entire
    // tree (the worker spawns `claude`/`git` children) in one signal to the
    // group.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("failed to spawn worker: {e}"))?;

    // Registry holds the group id (== leader pid) so delete_mission can find
    // it; the guard clears it on every exit path, including a kill.
    if let Ok(mut map) = runs.0.lock() {
        map.insert(mission_id.to_string(), child.id());
    }
    let _guard = RunGuard {
        runs: runs.clone(),
        mission_id: mission_id.to_string(),
    };

    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");

    let stderr_handle = std::thread::spawn(move || {
        let mut s = String::new();
        BufReader::new(stderr).read_to_string(&mut s).ok();
        s
    });

    let reader = BufReader::new(stdout);
    let mut final_state = String::new();

    for line in reader.lines() {
        let line = line.map_err(|e| format!("failed to read worker output: {e}"))?;
        if let Some(json_str) = line.strip_prefix("EVENT:") {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(json_str) {
                let _ = app.emit("workflow_event", val);
            }
        } else if let Some(json_str) = line.strip_prefix("PATCH:") {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(json_str) {
                let _ = app.emit("patch_proposal", val);
            }
        } else if let Some(json_str) = line.strip_prefix("CHAT:") {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(json_str) {
                let _ = app.emit("chat_message", val);
            }
        } else if let Some(json_str) = line.strip_prefix("RUN:") {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(json_str) {
                let _ = app.emit("agent_run", val);
            }
        } else if let Some(json_str) = line.strip_prefix("STATE:") {
            final_state = json_str.to_string();
        }
    }

    let status = child.wait().map_err(|e| format!("failed to wait for worker: {e}"))?;
    let stderr_output = stderr_handle.join().unwrap_or_default();

    if !status.success() {
        let err = stderr_output.trim().to_string();
        return Err(if err.is_empty() {
            format!("worker exited with status {status}")
        } else {
            err
        });
    }

    if final_state.is_empty() {
        return Err("worker produced no final state".to_string());
    }

    Ok(final_state)
}

fn run_worker_status(repo_path: &str) -> Result<String, String> {
    run_worker(&["status", "--json", repo_path])
}

fn run_worker(args: &[&str]) -> Result<String, String> {
    let output = Command::new(worker_binary()?)
        .args(args)
        .output()
        .map_err(|error| format!("failed to run worker: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.is_empty() {
            return Err(format!("worker exited with status {}", output.status));
        }

        return Err(stderr);
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn worker_dir() -> Result<PathBuf, String> {
    // apps/desktop/src-tauri -> repo root
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .ancestors()
        .nth(3)
        .map(|repo_dir| repo_dir.join("worker"))
        .ok_or_else(|| "failed to resolve worker directory".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Apps launched from Finder inherit launchd's minimal PATH, not the user's
/// shell PATH — so the worker's children (`claude`, `node`, ...) installed in
/// ~/.local/bin, Homebrew, or nvm are not found. Adopt the login shell's PATH
/// so every spawned worker sees the same commands a terminal would.
#[cfg(target_os = "macos")]
fn adopt_login_shell_path() {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    // Interactive + login shell: PATH exports commonly live in .zshrc, which
    // a plain login shell never reads. Interactive rc files may print their
    // own output, so the echoed PATH is the last non-empty stdout line.
    let Ok(output) = Command::new(shell).args(["-ilc", "echo $PATH"]).output() else {
        return;
    };
    if !output.status.success() {
        return;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    if let Some(path) = stdout.lines().rev().find(|line| !line.trim().is_empty()) {
        std::env::set_var("PATH", path.trim());
    }
}

pub fn run() {
    #[cfg(target_os = "macos")]
    adopt_login_shell_path();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(RunningRuns::default())
        .invoke_handler(tauri::generate_handler![
            load_worker_state,
            refresh_demo_worker_loop,
            open_repository,
            queue_mission,
            update_mission_text,
            start_agent_run,
            send_agent_message,
            delete_mission,
            link_missions,
            unlink_missions,
            decompose_mission,
            plan_repo,
            approve_patch,
            reject_patch,
            verify_mission,
            load_repo_history,
            load_commit_diff,
            list_models
        ])
        .run(tauri::generate_context!())
        .expect("error while running Orbital");
}
