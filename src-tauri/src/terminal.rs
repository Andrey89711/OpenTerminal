use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{Arc, Mutex},
};
use tauri::{ipc::Channel, State};

struct Session {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

#[derive(Default, Clone)]
pub struct TerminalManager {
    sessions: Arc<Mutex<HashMap<String, Arc<Session>>>>,
}

impl TerminalManager {
    fn get(&self, id: &str) -> Result<Arc<Session>, String> {
        self.sessions
            .lock()
            .map_err(|e| e.to_string())?
            .get(id)
            .cloned()
            .ok_or_else(|| "Session is closed".into())
    }

    pub fn close_all(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for (_, session) in sessions.drain() {
                if let Ok(mut killer) = session.killer.lock() {
                    let _ = killer.kill();
                }
            }
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum TerminalEvent {
    Data { data: Vec<u8> },
    Exit { code: u32 },
    Error { message: String },
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.clamp(1, 500),
        cols: cols.clamp(2, 1000),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn shell_command(shell: &str) -> Result<CommandBuilder, String> {
    #[cfg(windows)]
    let mut command = match shell {
        "powershell" => {
            let pwsh = std::env::var_os("PATH").and_then(|path| {
                std::env::split_paths(&path)
                    .map(|part| part.join("pwsh.exe"))
                    .find(|p| p.is_file())
            });
            let mut cmd = CommandBuilder::new(pwsh.unwrap_or_else(|| "powershell.exe".into()));
            cmd.arg("-NoLogo");
            cmd
        }
        "cmd" => CommandBuilder::new("cmd.exe"),
        "wsl" => CommandBuilder::new("wsl.exe"),
        _ => return Err("Unsupported shell".into()),
    };
    #[cfg(not(windows))]
    let mut command = match shell {
        "powershell" | "cmd" => {
            CommandBuilder::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into()))
        }
        _ => return Err("This shell is available on Windows only".into()),
    };
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        command.cwd(home);
    }
    Ok(command)
}

#[tauri::command]
pub fn create_terminal(
    id: String,
    shell: String,
    cols: u16,
    rows: u16,
    channel: Channel<TerminalEvent>,
    manager: State<'_, TerminalManager>,
) -> Result<(), String> {
    spawn_session(id, shell, cols, rows, channel, &manager)
}

fn spawn_session(
    id: String,
    shell: String,
    cols: u16,
    rows: u16,
    channel: Channel<TerminalEvent>,
    manager: &TerminalManager,
) -> Result<(), String> {
    let command = shell_command(&shell)?;
    spawn_command(id, command, cols, rows, channel, manager)
}

fn spawn_command(
    id: String,
    mut command: CommandBuilder,
    cols: u16,
    rows: u16,
    channel: Channel<TerminalEvent>,
    manager: &TerminalManager,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        // portable-pty also merges registry values into the process environment.
        // Use the actual parent environment, just like a normal child process.
        command.env_clear();
        for (key, value) in std::env::vars_os() {
            command.env(key, value);
        }
    }
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "OpenTerminal");
    if id.is_empty() || id.len() > 128 {
        return Err("Invalid session ID".into());
    }
    let mut sessions = manager.sessions.lock().map_err(|e| e.to_string())?;
    if sessions.contains_key(&id) {
        return Err("Session already exists".into());
    }
    if sessions.len() >= 32 {
        return Err("Maximum of 32 sessions reached".into());
    }
    let pair = native_pty_system()
        .openpty(size(cols, rows))
        .map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|e| e.to_string())?;
    drop(pair.slave);
    let session = Arc::new(Session {
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        killer: Mutex::new(child.clone_killer()),
    });
    sessions.insert(id.clone(), session.clone());
    drop(sessions);
    let reader_session = Arc::downgrade(&session);
    drop(session);
    let output_channel = channel.clone();
    let reader_thread = std::thread::spawn(move || {
        let mut buffer = [0u8; 16384];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    if output_channel
                        .send(TerminalEvent::Data {
                            data: buffer[..count].to_vec(),
                        })
                        .is_err()
                    {
                        if let Some(session) = reader_session.upgrade() {
                            if let Ok(mut killer) = session.killer.lock() {
                                let _ = killer.kill();
                            }
                        }
                        break;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => {
                    // Windows reports a broken pipe when ConPTY closes normally.
                    if error.kind() != std::io::ErrorKind::BrokenPipe {
                        let _ = output_channel.send(TerminalEvent::Error {
                            message: error.to_string(),
                        });
                    }
                    if let Some(session) = reader_session.upgrade() {
                        if let Ok(mut killer) = session.killer.lock() {
                            let _ = killer.kill();
                        }
                    }
                    break;
                }
            }
        }
    });
    let all_sessions = manager.sessions.clone();
    std::thread::spawn(move || {
        let code = child.wait().map(|status| status.exit_code()).unwrap_or(1);
        // Drop the master before joining: ConPTY can keep its output pipe open
        // after the shell exits. The reader must stay alive to drain final output.
        let session = all_sessions
            .lock()
            .ok()
            .and_then(|mut sessions| sessions.remove(&id));
        drop(session);
        let _ = reader_thread.join();
        let _ = channel.send(TerminalEvent::Exit { code });
    });
    Ok(())
}

#[tauri::command]
pub fn write_terminal(
    id: String,
    data: String,
    manager: State<'_, TerminalManager>,
) -> Result<(), String> {
    if data.len() > 1024 * 1024 {
        return Err("Input exceeds 1 MiB; paste smaller chunks".into());
    }
    let session = manager.get(&id)?;
    let mut writer = session.writer.lock().map_err(|e| e.to_string())?;
    writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn resize_terminal(
    id: String,
    cols: u16,
    rows: u16,
    manager: State<'_, TerminalManager>,
) -> Result<(), String> {
    let session = manager.get(&id)?;
    let master = session.master.lock().map_err(|e| e.to_string())?;
    master.resize(size(cols, rows)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn close_terminal(id: String, manager: State<'_, TerminalManager>) -> Result<(), String> {
    let session = manager
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&id);
    if let Some(session) = session {
        session
            .killer
            .lock()
            .map_err(|e| e.to_string())?
            .kill()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pty_dimensions_are_bounded() {
        let small = size(0, 0);
        assert_eq!((small.cols, small.rows), (2, 1));
        let large = size(u16::MAX, u16::MAX);
        assert_eq!((large.cols, large.rows), (1000, 500));
        let normal = size(120, 32);
        assert_eq!((normal.cols, normal.rows), (120, 32));
    }

    #[test]
    fn arbitrary_commands_are_not_accepted_as_shell_profiles() {
        assert!(shell_command("cmd.exe /c echo injected").is_err());
        assert!(shell_command("").is_err());
    }

    #[test]
    fn missing_session_returns_error_and_close_all_is_idempotent() {
        let manager = TerminalManager::default();
        assert!(manager.get("missing").is_err());
        manager.close_all();
        manager.close_all();
        assert!(manager.sessions.lock().unwrap().is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn windows_shell_profiles_are_supported() {
        for shell in ["powershell", "cmd", "wsl"] {
            assert!(shell_command(shell).is_ok());
        }
    }

    #[cfg(windows)]
    #[test]
    fn real_conpty_session_accepts_input_resizes_and_exits() {
        check_conpty_shell(shell_command("cmd").unwrap());
    }

    #[cfg(windows)]
    #[test]
    fn powershell_starts_in_conpty() {
        check_conpty_shell(shell_command("powershell").unwrap());
    }

    #[cfg(windows)]
    #[test]
    fn windows_powershell_starts_in_conpty() {
        let path = std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let mut command = CommandBuilder::new(path);
        command.arg("-NoLogo");
        check_conpty_shell(command);
    }

    #[cfg(windows)]
    fn check_conpty_shell(command: CommandBuilder) {
        use std::{
            sync::mpsc,
            time::{Duration, Instant},
        };
        let manager = TerminalManager::default();
        let (sender, receiver) = mpsc::channel();
        let channel = Channel::<TerminalEvent>::new(move |body| {
            let event = body.deserialize::<TerminalEvent>().unwrap();
            let _ = sender.send(event);
            Ok(())
        });
        spawn_command("smoke-test".into(), command, 100, 30, channel, &manager).unwrap();
        {
            let session = manager.get("smoke-test").unwrap();
            session
                .master
                .lock()
                .unwrap()
                .resize(size(120, 32))
                .unwrap();
        }
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut output = Vec::new();
        let mut exit_code = None;
        let mut handshake_sent = false;
        while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
            match receiver.recv_timeout(remaining) {
                Ok(TerminalEvent::Data { data }) => {
                    output.extend(data);
                    if !handshake_sent && output.windows(4).any(|part| part == b"\x1b[6n") {
                        let session = manager.get("smoke-test").unwrap();
                        let mut writer = session.writer.lock().unwrap();
                        // Emulate xterm's cursor-position response before user input.
                        writer
                            .write_all(b"\x1b[1;1Recho OpenTerminal_PTY_OK\rexit 7\r")
                            .unwrap();
                        writer.flush().unwrap();
                        handshake_sent = true;
                    }
                }
                Ok(TerminalEvent::Exit { code }) => {
                    exit_code = Some(code);
                    break;
                }
                Ok(TerminalEvent::Error { .. }) => (),
                Err(_) => break,
            }
        }
        manager.close_all();
        assert_eq!(
            exit_code,
            Some(7),
            "Shell did not exit cleanly: {}",
            String::from_utf8_lossy(&output)
        );
        assert!(String::from_utf8_lossy(&output).contains("OpenTerminal_PTY_OK"));
        assert!(manager.sessions.lock().unwrap().is_empty());
    }
}
