use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, State};

/// Each run is its own process-group leader, so killing the group id stored
/// here tears down the whole tree (worker binary + any `claude`/`git` children).
#[derive(Default, Clone)]
struct RunningRuns(Arc<Mutex<HashMap<String, u32>>>);

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

/// Cached per app launch; a build failure is not cached, so it's retried on the next call.
static WORKER_BINARY: Mutex<Option<PathBuf>> = Mutex::new(None);

fn worker_binary() -> Result<PathBuf, String> {
    let mut cached = WORKER_BINARY
        .lock()
        .map_err(|_| "worker binary lock poisoned".to_string())?;
    if let Some(path) = cached.as_ref() {
        return Ok(path.clone());
    }

    // Resolution order: explicit override, sidecar (bundled builds), then build from source (dev).
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
fn open_repository(repo_path: String) -> Result<String, String> {
    run_worker(&["open", repo_path.trim()])
}

#[tauri::command]
fn queue_mission(
    repo_path: String,
    mission_text: String,
    campaign_id: Option<String>,
    tool_command: Option<String>,
    model: Option<String>,
) -> Result<String, String> {
    let mut args = vec!["queue", repo_path.trim(), mission_text.trim()];
    if let Some(id) = campaign_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        args.extend(["--campaign", id]);
    }
    if let Some(cmd) = tool_command
        .as_deref()
        .map(str::trim)
        .filter(|cmd| !cmd.is_empty())
    {
        args.extend(["--tool", cmd]);
    }
    if let Some(model) = model.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
        args.extend(["--model", model]);
    }
    run_worker(&args)
}

// The saved path travels inside mission/chat text; the agent opens the file from disk to view it.
#[tauri::command]
fn save_attachment(repo_path: String, extension: String, data: String) -> Result<String, String> {
    use base64::Engine as _;

    let ext = extension
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase();
    let safe_ext =
        if !ext.is_empty() && ext.len() <= 5 && ext.chars().all(|c| c.is_ascii_alphanumeric()) {
            ext
        } else {
            "png".to_string()
        };

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|e| format!("attachment decode failed: {e}"))?;

    let dir = std::path::Path::new(repo_path.trim())
        .join(".orbital")
        .join("attachments");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let path = dir.join(format!("attachment_{stamp}.{safe_ext}"));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

// Two of the arguments are Tauri-injected; the rest are the IPC payload, so
// grouping them into a struct would change the shape the frontend sends.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn start_agent_run(
    app: tauri::AppHandle,
    runs: State<'_, RunningRuns>,
    repo_path: String,
    mission_id: String,
    worker_name: String,
    command: Option<String>,
    model: Option<String>,
    effort: Option<String>,
) -> Result<String, String> {
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
    if let Some(effort) = effort.as_deref().map(str::trim).filter(|e| !e.is_empty()) {
        args.extend(["--effort".into(), effort.to_string()]);
    }

    let runs = runs.inner().clone();
    let mission_id = mission_id.trim().to_string();

    // Long-running commands must stay async + spawn_blocking, or the UI thread freezes.
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
    effort: Option<String>,
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
    if let Some(effort) = effort.as_deref().map(str::trim).filter(|e| !e.is_empty()) {
        args.extend(["--effort".into(), effort.to_string()]);
    }

    let runs = runs.inner().clone();
    let mission_id = mission_id.trim().to_string();

    // Must stay async + spawn_blocking, or the UI thread freezes while the agent works.
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
    run_worker(&[
        "edit-mission",
        repo_path.trim(),
        mission_id.trim(),
        text.trim(),
    ])
}

#[tauri::command]
fn delete_mission(
    runs: State<'_, RunningRuns>,
    repo_path: String,
    mission_id: String,
) -> Result<String, String> {
    let mission_id = mission_id.trim();

    // Kill the live agent first so it can't keep writing to the worktree we're about to remove.
    let pgid = runs
        .0
        .lock()
        .ok()
        .and_then(|map| map.get(mission_id).copied());
    if let Some(pgid) = pgid {
        kill_process_group(pgid);
    }

    run_worker(&["delete", repo_path.trim(), mission_id])
}

/// SIGTERM first to let `claude`/`git` unwind, then SIGKILL as fallback. A negative pid targets the whole group.
#[cfg(unix)]
fn kill_process_group(pgid: u32) {
    let _ = Command::new("kill")
        .arg("-TERM")
        .arg(format!("-{pgid}"))
        .status();
    std::thread::sleep(std::time::Duration::from_millis(400));
    let _ = Command::new("kill")
        .arg("-KILL")
        .arg(format!("-{pgid}"))
        .status();
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
fn link_missions(
    repo_path: String,
    from_mission_id: String,
    to_mission_id: String,
) -> Result<String, String> {
    run_worker(&[
        "link",
        repo_path.trim(),
        from_mission_id.trim(),
        to_mission_id.trim(),
    ])
}

#[tauri::command]
fn unlink_missions(
    repo_path: String,
    from_mission_id: String,
    to_mission_id: String,
) -> Result<String, String> {
    run_worker(&[
        "unlink",
        repo_path.trim(),
        from_mission_id.trim(),
        to_mission_id.trim(),
    ])
}

#[tauri::command]
fn approve_patch(repo_path: String, mission_id: String, message: String) -> Result<String, String> {
    run_worker(&[
        "approve",
        repo_path.trim(),
        mission_id.trim(),
        message.trim(),
    ])
}

#[tauri::command]
fn reject_patch(repo_path: String, mission_id: String) -> Result<String, String> {
    run_worker(&["reject", repo_path.trim(), mission_id.trim()])
}

#[tauri::command]
fn amend_commit(repo_path: String, mission_id: String, message: String) -> Result<String, String> {
    run_worker(&["amend", repo_path.trim(), mission_id.trim(), message.trim()])
}

#[tauri::command]
fn git_sync(repo_path: String) -> Result<String, String> {
    run_worker(&["git-sync", repo_path.trim()])
}

// Pushing talks to a remote, so it can take seconds: off the UI thread or the
// window freezes for the whole round trip.
#[tauri::command]
async fn push_repo(repo_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || run_worker(&["push", repo_path.trim()]))
        .await
        .map_err(|error| error.to_string())?
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

    // Own process group so a delete can kill the whole tree (worker + `claude`/`git` children) in one signal.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("failed to spawn worker: {e}"))?;

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

    let status = child
        .wait()
        .map_err(|e| format!("failed to wait for worker: {e}"))?;
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
    // app/src-tauri -> repo root
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .ancestors()
        .nth(2)
        .map(|repo_dir| repo_dir.join("worker"))
        .ok_or_else(|| "failed to resolve worker directory".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
// Apps launched from Finder inherit launchd's minimal PATH, not the user's shell PATH,
// so worker children (`claude`, `node`, ...) in ~/.local/bin, Homebrew, or nvm aren't found.
#[cfg(target_os = "macos")]
fn adopt_login_shell_path() {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    // -ilc: PATH exports commonly live in .zshrc, which a plain login shell never reads.
    // Interactive rc files may print their own output, so take the last non-empty stdout line.
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
            open_repository,
            queue_mission,
            save_attachment,
            update_mission_text,
            start_agent_run,
            send_agent_message,
            delete_mission,
            link_missions,
            unlink_missions,
            approve_patch,
            reject_patch,
            amend_commit,
            git_sync,
            push_repo,
            load_repo_history,
            load_commit_diff,
            list_models
        ])
        .run(tauri::generate_context!())
        .expect("error while running Orbital");
}
