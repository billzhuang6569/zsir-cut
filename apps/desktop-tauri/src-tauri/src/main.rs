#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    io::{BufRead, BufReader},
    path::Path,
    process::{Child, Command, Stdio},
    sync::Mutex,
};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

struct Host(Mutex<Child>);
impl Drop for Host {
    fn drop(&mut self) {
        if let Ok(child) = self.0.get_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn main() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
            let project = std::env::var_os("ZCUT_PROJECT")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| root.join("examples/interview.zcut.json"));
            let child = Command::new("node")
                .current_dir(&root)
                .arg(root.join("packages/app-host/dist/index.js"))
                .args(["--desktop", "--project"])
                .arg(&project)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()?;
            let mut host = Host(Mutex::new(child));
            let child = host.0.get_mut().map_err(|_| "Host lock poisoned")?;
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
            app.manage(host);
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("庄Sir剪辑助手")
                .inner_size(1440.0, 900.0)
                .initialization_script(&script)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to run zsir-cut desktop");
    app.run(|app, event| {
        if let RunEvent::Exit = event {
            if let Ok(mut child) = app.state::<Host>().0.lock() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    });
}
