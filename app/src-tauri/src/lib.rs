use std::path::PathBuf;
use std::process::Command;

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
fn start_agent_run(
    repo_path: String,
    mission_id: String,
    worker_name: Option<String>,
    command: Option<String>,
) -> Result<String, String> {
    let worker_name = worker_name.unwrap_or_else(|| "mock".to_string());
    if worker_name.trim() == "local-command" {
        let command = command.unwrap_or_default();
        return run_worker(&[
            "start-run",
            repo_path.trim(),
            mission_id.trim(),
            "--worker",
            "local-command",
            "--command",
            command.trim(),
        ]);
    }

    run_worker(&[
        "start-run",
        repo_path.trim(),
        mission_id.trim(),
        "--worker",
        worker_name.trim(),
    ])
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
