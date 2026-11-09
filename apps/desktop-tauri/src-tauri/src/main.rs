#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    collections::VecDeque,
    error::Error,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

fn node_path(path: &Path) -> PathBuf {
    dunce::simplified(path).to_path_buf()
}

fn stderr_tail(mut input: impl Read) -> String {
    let mut tail = VecDeque::new();
    let mut buffer = [0; 4096];
    loop {
        match input.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                tail.extend(&buffer[..count]);
                let excess = tail.len().saturating_sub(8192);
                tail.drain(..excess);
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    let bytes: Vec<u8> = tail.into_iter().collect();
    let text = String::from_utf8_lossy(&bytes);
    let mut lines: Vec<_> = text.lines().rev().take(10).collect();
    lines.reverse();
    lines.join("\n")
}

struct Host(Mutex<Child>);
impl Host {
    fn stop(&self) {
        if let Ok(mut child) = self.0.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        self.stop();
    }
}

fn host_script(child: &mut Child) -> Result<String, Box<dyn Error>> {
    let mut output = BufReader::new(child.stdout.take().ok_or("Missing host output")?);
    let mut ready = String::new();
    output.read_line(&mut ready)?;
    let mut parts = ready.split_whitespace();
    let port: u16 = parts.next().ok_or("Missing host port")?.parse()?;
    let token = parts.next().ok_or("Missing host token")?;
    if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Invalid host token".into());
    }
    let script = format!("window.__ZCUT_HOST__ = {{port: {port}, token: '{token}'}};");
    // Keep draining MCP stdout so the child cannot block on a full pipe.
    std::thread::spawn(move || {
        let _ = std::io::copy(&mut output, &mut std::io::sink());
    });
    Ok(script)
}

fn start_host(command: &mut Command) -> Result<(Host, String), Box<dyn Error>> {
    let child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut host = Host(Mutex::new(child));
    let child = host.0.get_mut().map_err(|_| "Host lock poisoned")?;
    let stderr = child.stderr.take().ok_or("Missing host errors")?;
    // Drain from the start, bounding memory even when errors have no newlines.
    let errors = std::thread::spawn(move || stderr_tail(stderr));
    match host_script(child) {
        Ok(script) => Ok((host, script)),
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            let tail = errors.join().unwrap_or_else(|_| "无法读取错误详情".into());
            Err(format!("{error}\n\n{tail}").into())
        }
    }
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn Error>> {
    let root = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
    } else {
        app.path().resource_dir()?.join("runtime")
    };
    // All Node paths (executable, script, cwd and PATH/bin) derive from this root.
    let root = node_path(&root);
    let node = if cfg!(debug_assertions) {
        PathBuf::from("node")
    } else {
        root.join(if cfg!(windows) { "node.exe" } else { "node" })
    };
    let mut command = Command::new(node);
    if !cfg!(debug_assertions) {
        command.env("ZCUT_PACKAGED", "1");
        let mut paths = vec![root.join("bin")];
        paths.extend(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        ));
        command.env("PATH", std::env::join_paths(paths)?);
    }
    command.env("PYTHONDONTWRITEBYTECODE", "1");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    command
        .current_dir(&root)
        .arg(root.join("packages/app-host/dist/index.js"))
        .arg("--desktop");
    if let Some(project) = std::env::var_os("ZCUT_PROJECT").filter(|value| !value.is_empty()) {
        command.arg("--project").arg(project);
    }
    let (host, script) = start_host(&mut command)?;
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("庄Sir剪辑助手")
        .inner_size(1440.0, 900.0)
        .initialization_script(&script)
        .build()?;
    app.manage(host);
    Ok(())
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::Builder::new().build())
        .setup(|app| {
            if let Err(error) = setup(app) {
                let handle = app.handle().clone();
                app.dialog()
                    .message(format!("无法启动应用。\n\n{error}"))
                    .title("庄Sir剪辑助手启动失败")
                    .kind(MessageDialogKind::Error)
                    .show(move |_| handle.exit(1));
            }
            Ok(())
        })
        .build(tauri::generate_context!());
    let app = match app {
        Ok(app) => app,
        Err(error) => {
            eprintln!("庄Sir剪辑助手启动失败：{error}");
            std::process::exit(1);
        }
    };
    app.run(|app, event| {
        if let RunEvent::Exit = event {
            if let Some(host) = app.try_state::<Host>() {
                host.stop();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_paths_are_unchanged() {
        for path in [
            r"D:\a",
            r"\\server\share\a",
            "/Applications/庄Sir/runtime",
            "node",
        ] {
            assert_eq!(node_path(Path::new(path)), PathBuf::from(path));
        }
    }

    #[cfg(windows)]
    #[test]
    fn simplifies_disk_paths_and_preserves_unc_paths() {
        assert_eq!(node_path(Path::new(r"\\?\D:\a")), PathBuf::from(r"D:\a"));
        let unc = Path::new(r"\\?\UNC\server\share\a");
        assert_eq!(node_path(unc), unc);
        for suffix in ["node.exe", "packages/app-host/dist/index.js", "bin"] {
            assert!(!node_path(Path::new(r"\\?\D:\a"))
                .join(suffix)
                .starts_with(r"\\?\D:\"));
        }
    }

    #[test]
    fn stderr_retains_only_the_last_ten_lines_or_eight_kibibytes() {
        let lines = (0..100)
            .map(|i| format!("错误 {i}\r\n"))
            .collect::<String>();
        let tail = stderr_tail(lines.as_bytes());
        assert_eq!(tail.lines().count(), 10);
        assert!(tail.starts_with("错误 90\n"));
        assert!(tail.ends_with("错误 99"));
        assert_eq!(stderr_tail(&vec![b'x'; 256 * 1024][..]).len(), 8192);
        assert!(stderr_tail(&b"\xff\nError: EISDIR"[..]).ends_with("Error: EISDIR"));
    }

    fn node_command(script: &str) -> Command {
        let mut command = Command::new("node");
        command.arg("-e").arg(script);
        command
    }

    #[test]
    fn drains_large_stderr_before_ready_and_stdout_after_ready() {
        let mut command = node_command(
            "process.stderr.write(Buffer.alloc(256 * 1024, 120), () => {
                 process.stdout.write('4321 ' + 'a'.repeat(64) + '\\n');
                 process.stdout.write(Buffer.alloc(256 * 1024, 120));
             });",
        );
        let (host, script) = start_host(&mut command).unwrap();
        assert_eq!(
            script,
            format!(
                "window.__ZCUT_HOST__ = {{port: 4321, token: '{}'}};",
                "a".repeat(64)
            )
        );
        assert!(host.0.lock().unwrap().wait().unwrap().success());
    }

    #[test]
    fn failed_startup_includes_final_stderr_without_a_console() {
        let mut command = node_command(
            "process.stderr.write(Buffer.alloc(256 * 1024, 120));
             process.stderr.write('\\nError: EISDIR\\n    at Object.realpathSync\\n');
             process.exitCode = 1;",
        );
        let error = start_host(&mut command).err().unwrap().to_string();
        assert!(error.contains("Missing host port"));
        assert!(
            error.ends_with("Error: EISDIR\n    at Object.realpathSync"),
            "{error:?}"
        );
        assert!(error.len() < 8300);
    }

    #[test]
    fn rejects_invalid_port_and_missing_or_invalid_token() {
        for ready in [
            "invalid token",
            "4321",
            "4321 bad",
            &format!("4321 {}", "g".repeat(64)),
        ] {
            let mut command = node_command(&format!("console.log('{ready}')"));
            assert!(start_host(&mut command).is_err());
        }
    }

    #[test]
    fn missing_node_returns_a_startup_error() {
        let mut command =
            Command::new(Path::new(env!("CARGO_MANIFEST_DIR")).join("missing-node.exe"));
        assert!(start_host(&mut command).is_err());
    }
}
