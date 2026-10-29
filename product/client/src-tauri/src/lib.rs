use serde_json::Value;

const MAX_FRAME_SIZE: usize = 16 * 1024;
const PIPE: &str = r"\\.\pipe\nexo-endpoint-v1";

#[tauri::command]
async fn service_request(request: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || request_service(request))
        .await
        .map_err(|_| "service_unavailable".to_string())?
}

fn request_service(request: Value) -> Result<Value, String> {
    let action = request
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !matches!(
        action,
        "status" | "diagnostics" | "enroll" | "claim" | "run_diagnostic"
    ) {
        return Err("unsupported_action".to_string());
    }
    let mut encoded = serde_json::to_vec(&request).map_err(|_| "invalid_request".to_string())?;
    if encoded.len() + 1 > MAX_FRAME_SIZE {
        return Err("invalid_request".to_string());
    }
    encoded.push(b'\n');
    platform::exchange(PIPE, &encoded)
}

#[cfg(target_os = "windows")]
mod platform {
    use super::MAX_FRAME_SIZE;
    use serde_json::Value;
    use std::fs::OpenOptions;
    use std::io::{BufRead, BufReader, Read, Write};

    pub fn exchange(pipe: &str, request: &[u8]) -> Result<Value, String> {
        let mut connection = OpenOptions::new()
            .read(true)
            .write(true)
            .open(pipe)
            .map_err(|_| "service_unavailable".to_string())?;
        connection
            .write_all(request)
            .map_err(|_| "service_unavailable".to_string())?;
        connection
            .flush()
            .map_err(|_| "service_unavailable".to_string())?;
        let mut response = Vec::new();
        BufReader::new(connection)
            .take((MAX_FRAME_SIZE + 1) as u64)
            .read_until(b'\n', &mut response)
            .map_err(|_| "service_unavailable".to_string())?;
        if response.len() > MAX_FRAME_SIZE || response.last() != Some(&b'\n') {
            return Err("invalid_response".to_string());
        }
        serde_json::from_slice(&response[..response.len() - 1])
            .map_err(|_| "invalid_response".to_string())
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    use serde_json::Value;
    pub fn exchange(_: &str, _: &[u8]) -> Result<Value, String> {
        Err("windows_required".to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![service_request])
        .run(tauri::generate_context!())
        .expect("failed to run NEXO client");
}
