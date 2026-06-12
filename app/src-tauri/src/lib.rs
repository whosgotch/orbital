use std::path::PathBuf;
use std::process::Command;

const DEMO_REPO_PATH: &str = "/private/tmp/orbital-demo-repo";
const GO_CACHE_PATH: &str = "/private/tmp/orbital-go-cache";

#[tauri::command]
fn load_worker_state() -> Result<String, String> {
    run_worker_status()
}

fn run_worker_status() -> Result<String, String> {
    let worker_dir = worker_dir()?;
    let output = Command::new("go")
        .args([
            "run",
            "./cmd/orbital",
            "status",
            "--json",
            DEMO_REPO_PATH,
        ])
        .current_dir(worker_dir)
        .env("GOCACHE", GO_CACHE_PATH)
        .output()
        .map_err(|error| format!("failed to run worker: {error}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
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
        .invoke_handler(tauri::generate_handler![load_worker_state])
        .run(tauri::generate_context!())
        .expect("error while running Orbital");
}
