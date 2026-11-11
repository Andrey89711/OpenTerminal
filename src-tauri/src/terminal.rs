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
    profile_command(shell, None, None)
}

fn expand_directory_with(
    value: &str,
    env: impl Fn(&str) -> Option<String>,
) -> Result<String, String> {
    const MAX_PATH_BYTES: usize = 32768;
    if value.is_empty() || value.len() > MAX_PATH_BYTES || value.chars().any(char::is_control) {
        return Err("Invalid starting directory".into());
    }
    let mut expanded = String::new();
    let mut remaining = value;
    if value == "~" || value.starts_with("~/") || value.starts_with("~\\") {
        expanded = env("USERPROFILE")
            .or_else(|| env("HOME"))
            .ok_or("Home directory is unavailable")?;
        remaining = &value[1..];
    } else if value.starts_with('~') {
        return Err("Only the current user's home directory can be expanded".into());
    }
    while let Some(start) = remaining.find('%') {
        expanded.push_str(&remaining[..start]);
        let tail = &remaining[start + 1..];
        let end = tail
            .find('%')
            .ok_or("Malformed directory environment variable")?;
        let name = &tail[..end];
        if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
            return Err("Malformed directory environment variable".into());
        }
        expanded.push_str(
            &env(name).ok_or_else(|| format!("Unknown directory environment variable: {name}"))?,
        );
        if expanded.len() > MAX_PATH_BYTES {
            return Err("Starting directory is too long".into());
        }
        remaining = &tail[end + 1..];
    }
    expanded.push_str(remaining);
    if expanded.is_empty()
        || expanded.len() > MAX_PATH_BYTES
        || expanded.chars().any(char::is_control)
    {
        return Err("Invalid starting directory".into());
    }
    Ok(expanded)
}

fn starting_directory(value: &str) -> Result<std::path::PathBuf, String> {
    let expanded = expand_directory_with(value, |name| std::env::var(name).ok())?;
    let path = std::path::PathBuf::from(expanded);
    if !path.is_dir() {
        return Err("Starting directory does not exist or is not a directory".into());
    }
    Ok(path)
}

fn validate_distribution(distribution: &str) -> Result<(), String> {
    if distribution.is_empty()
        || distribution.len() > 128
        || distribution.starts_with('-')
        || distribution.chars().any(char::is_control)
    {
        return Err("Invalid WSL distribution".into());
    }
    Ok(())
}

fn profile_command(
    shell: &str,
    directory: Option<&str>,
    distribution: Option<&str>,
) -> Result<CommandBuilder, String> {
    profile_command_with_no_profile(shell, directory, distribution, false)
}

fn profile_command_with_no_profile(
    shell: &str,
    directory: Option<&str>,
    distribution: Option<&str>,
    no_profile: bool,
) -> Result<CommandBuilder, String> {
    if no_profile {
        if !matches!(shell, "powershell" | "windows-powershell") {
            return Err("NoProfile is only supported for PowerShell shells".into());
        }
        #[cfg(not(windows))]
        return Err("NoProfile is only supported for PowerShell on Windows".into());
    }
    if let Some(distribution) = distribution {
        validate_distribution(distribution)?;
        if shell != "wsl" {
            return Err("A distribution can only be selected for WSL".into());
        }
    }
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
        "windows-powershell" => {
            let mut cmd = CommandBuilder::new("powershell.exe");
            cmd.arg("-NoLogo");
            cmd
        }
        "wsl" => {
            let mut cmd = CommandBuilder::new("wsl.exe");
            if let Some(distribution) = distribution {
                cmd.arg("--distribution");
                cmd.arg(distribution);
            }
            cmd
        }
        _ => return Err("Unsupported shell".into()),
    };
    #[cfg(not(windows))]
    let mut command = match shell {
        "powershell" | "cmd" => {
            CommandBuilder::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into()))
        }
        _ => return Err("This shell is available on Windows only".into()),
    };
    #[cfg(windows)]
    if no_profile {
        command.arg("-NoProfile");
    }
    if let Some(directory) = directory {
        command.cwd(starting_directory(directory)?);
    } else if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))
    {
        command.cwd(home);
    }
    Ok(command)
}

#[tauri::command]
// Keep existing IPC arguments compatible; optional launch settings are explicit.
#[allow(clippy::too_many_arguments)]
pub fn create_terminal(
    id: String,
    shell: String,
    cols: u16,
    rows: u16,
    channel: Channel<TerminalEvent>,
    starting_directory: Option<String>,
    distribution: Option<String>,
    no_profile: Option<bool>,
    manager: State<'_, TerminalManager>,
) -> Result<(), String> {
    if starting_directory.is_none() && distribution.is_none() && !no_profile.unwrap_or(false) {
        return spawn_session(id, shell, cols, rows, channel, &manager);
    }
    let command = profile_command_with_no_profile(
        &shell,
        starting_directory.as_deref(),
        distribution.as_deref(),
        no_profile.unwrap_or(false),
    )?;
    spawn_command(id, command, cols, rows, channel, &manager)
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
        assert!(shell_command("C:\\Windows\\System32\\cmd.exe").is_err());
    }

    #[test]
    fn no_profile_rejects_non_powershell_shells_but_false_is_ignored() {
        for shell in ["cmd", "wsl", "arbitrary.exe"] {
            assert_eq!(
                profile_command_with_no_profile(shell, None, None, true).unwrap_err(),
                "NoProfile is only supported for PowerShell shells"
            );
        }
        assert!(profile_command_with_no_profile("cmd", None, None, false).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn no_profile_adds_only_a_fixed_powershell_argument() {
        for shell in ["powershell", "windows-powershell"] {
            let original = profile_command(shell, None, None).unwrap();
            let command = profile_command_with_no_profile(shell, None, None, true).unwrap();
            let mut expected = original.get_argv().to_vec();
            expected.push(std::ffi::OsString::from("-NoProfile"));
            assert_eq!(command.get_argv(), &expected);
            assert_eq!(
                profile_command_with_no_profile(shell, None, None, false)
                    .unwrap()
                    .get_argv(),
                original.get_argv()
            );
        }
    }

    #[test]
    fn directory_expansion_is_bounded_and_does_not_interpret_commands() {
        let env = |name: &str| match name {
            "USERPROFILE" | "HOME" => Some("fixture-home".into()),
            "LOCALAPPDATA" => Some("fixture-local".into()),
            "BAD" => Some("bad\npath".into()),
            "HUGE" => Some("x".repeat(32769)),
            _ => None,
        };
        assert_eq!(
            expand_directory_with("~/work", env).unwrap(),
            "fixture-home/work"
        );
        assert_eq!(
            expand_directory_with("%LOCALAPPDATA%/work", env).unwrap(),
            "fixture-local/work"
        );
        assert_eq!(
            expand_directory_with("dir; echo nope", env).unwrap(),
            "dir; echo nope"
        );
        for value in [
            "",
            "~other",
            "%UNKNOWN%",
            "%HOME",
            "%%",
            "%HOME-X%",
            "a\nb",
            "a\0b",
            "%BAD%",
            "%HUGE%",
        ] {
            assert!(expand_directory_with(value, env).is_err(), "{value:?}");
        }
    }

    #[test]
    fn starting_directory_must_exist_and_be_a_directory() {
        let cwd = std::env::current_dir().unwrap();
        assert_eq!(starting_directory(cwd.to_str().unwrap()).unwrap(), cwd);
        assert!(starting_directory("Cargo.toml").is_err());
        assert!(starting_directory("nonexistent-profile-directory-fixture").is_err());
        assert!(profile_command(
            "powershell",
            Some("nonexistent-profile-directory-fixture"),
            None
        )
        .is_err());
    }

    #[test]
    fn distribution_is_a_bounded_non_flag_value_for_wsl_only() {
        for value in ["Ubuntu", "Ubuntu 24.04", "distro; echo nope"] {
            assert!(validate_distribution(value).is_ok());
        }
        for value in [
            "",
            "--exec",
            "-Ubuntu",
            "Ubuntu\ncmd",
            "Ubuntu\0cmd",
            "Ubuntu\u{7f}",
        ] {
            assert!(validate_distribution(value).is_err());
        }
        assert!(validate_distribution(&"a".repeat(129)).is_err());
        assert!(profile_command("cmd", None, Some("Ubuntu")).is_err());
        assert!(profile_command("wsl", None, Some("--exec")).is_err());
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
        for shell in ["powershell", "windows-powershell", "cmd", "wsl"] {
            assert!(shell_command(shell).is_ok());
        }
    }

    #[cfg(windows)]
    #[test]
    fn profile_arguments_are_separate_and_windows_powershell_is_explicit() {
        let command = profile_command("wsl", None, Some("Ubuntu 24.04")).unwrap();
        assert_eq!(
            command.get_argv(),
            &["wsl.exe", "--distribution", "Ubuntu 24.04"].map(std::ffi::OsString::from)
        );
        let command = shell_command("windows-powershell").unwrap();
        assert_eq!(
            command.get_argv(),
            &["powershell.exe", "-NoLogo"].map(std::ffi::OsString::from)
        );
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
