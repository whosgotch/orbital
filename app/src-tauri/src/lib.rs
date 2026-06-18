use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use tauri::Emitter;

const DEMO_REPO_PATH: &str = "/private/tmp/orbital-demo-repo";
const DEMO_VERIFICATION_COMMAND: &str = "node -e \"console.log('verified')\"";
const GO_CACHE_PATH: &str = "/private/tmp/orbital-go-cache";

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
fn queue_mission(repo_path: String, mission_text: String) -> Result<String, String> {
    run_worker(&["queue", repo_path.trim(), mission_text.trim()])
}

#[tauri::command]
async fn start_agent_run(
    app: tauri::AppHandle,
    repo_path: String,
    mission_id: String,
    worker_name: Option<String>,
    command: Option<String>,
) -> Result<String, String> {
    let worker_name = worker_name.unwrap_or_else(|| "mock".to_string());
    let args: Vec<String> = if worker_name.trim() == "local-command" {
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

    // Run the blocking worker off the main thread so the UI stays responsive
    // while events stream in over the ~minute the run takes.
    tauri::async_runtime::spawn_blocking(move || {
        let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        run_worker_streaming(&app, &arg_refs)
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

fn run_worker_streaming(app: &tauri::AppHandle, args: &[&str]) -> Result<String, String> {
    let mut child = Command::new("go")
        .arg("run")
        .arg("./cmd/orbital")
        .args(args)
        .current_dir(worker_dir()?)
        .env("GOCACHE", GO_CACHE_PATH)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn worker: {e}"))?;

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
        } else if let Some(json_str) = line.strip_prefix("STATE:") {
            final_state = json_str.to_string();
        }
    }

    let status = child.wait().map_err(|e| format!("failed to wait for worker: {e}"))?;
    let stderr_output = stderr_handle.join().unwrap_or_default();

    if !status.success() {
        let err = stderr_output.trim().to_string();
        return Err(if err.is_empty() {
            format!("worker exited with status {}", status)
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
    let output = Command::new("go")
        .arg("run")
        .arg("./cmd/orbital")
        .args(args)
        .current_dir(worker_dir()?)
        .env("GOCACHE", GO_CACHE_PATH)
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
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .and_then(|app_dir| app_dir.parent())
        .map(|repo_dir| repo_dir.join("worker"))
        .ok_or_else(|| "failed to resolve worker directory".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            load_worker_state,
            refresh_demo_worker_loop,
            open_repository,
            queue_mission,
            start_agent_run,
            approve_patch,
            reject_patch,
            verify_mission
        ])
        .run(tauri::generate_context!())
        .expect("error while running Orbital");
}
