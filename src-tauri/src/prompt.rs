//! Only fixed OpenPrompt operations; no shell, arbitrary arguments or profile writes.
use serde::{Deserialize, Serialize};
use std::{
    io::Read,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

const OUTPUT_LIMIT: u64 = 256 * 1024;

#[derive(Serialize)]
pub struct Discovery {
    path: String,
    version: String,
    dev_fallback: bool,
}

#[derive(Deserialize, Serialize)]
pub struct Preview {
    theme: String,
    ansi: String,
    text: String,
}

fn validate_theme(theme: &str) -> Result<(), String> {
    match theme {
        "minimal" | "classic" | "blocks" => Ok(()),
        _ => Err("Неизвестная тема OpenPrompt. Выберите minimal, classic или blocks.".into()),
    }
}

fn executable(path: &Path) -> Result<PathBuf, String> {
    let valid_name = path
        .file_name()
        .and_then(|v| v.to_str())
        .is_some_and(|name| {
            name.eq_ignore_ascii_case("openprompt.exe") || name.eq_ignore_ascii_case("openprompt")
        });
    if !valid_name || !path.is_file() {
        return Err("Укажите существующий файл openprompt.exe (или openprompt).".into());
    }
    let absolute = path
        .canonicalize()
        .map_err(|_| "Не удалось открыть файл OpenPrompt.".to_string())?;
    let text = absolute
        .to_str()
        .ok_or("Путь к OpenPrompt должен быть корректным Unicode.")?;
    if text.chars().any(|ch| ch.is_control() || matches!(ch, '\u{061c}' | '\u{200b}'..='\u{200f}' | '\u{2028}'..='\u{202e}' | '\u{2060}'..='\u{206f}' | '\u{feff}')) {
        return Err("Путь к OpenPrompt содержит управляющие или невидимые символы.".into());
    }
    // Also check the resolved target, rather than accepting a renamed symlink.
    let name = absolute.file_name().and_then(|v| v.to_str()).unwrap_or("");
    if !name.eq_ignore_ascii_case("openprompt.exe") && !name.eq_ignore_ascii_case("openprompt") {
        return Err("Исполняемый файл должен называться openprompt.exe или openprompt.".into());
    }
    Ok(absolute)
}

struct Running(Child);
impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn reader(stream: impl Read + Send + 'static) -> mpsc::Receiver<Result<Vec<u8>, String>> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stream
            .take(OUTPUT_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Не удалось прочитать ответ OpenPrompt.".to_string())
            .and_then(|_| {
                if bytes.len() as u64 > OUTPUT_LIMIT {
                    Err("Ответ OpenPrompt слишком большой.".into())
                } else {
                    Ok(bytes)
                }
            });
        let _ = tx.send(result);
    });
    rx
}

fn run(path: &Path, args: &[&str], seconds: u64) -> Result<String, String> {
    let mut command = Command::new(path);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = Running(command.spawn().map_err(|_| {
        "Не удалось запустить OpenPrompt. Проверьте путь и разрешения.".to_string()
    })?);
    let stdout = reader(child.0.stdout.take().unwrap());
    let stderr = reader(child.0.stderr.take().unwrap());
    let deadline = Instant::now() + Duration::from_secs(seconds);
    let timeout = || "OpenPrompt не ответил вовремя. Повторите попытку.".to_string();
    let status = loop {
        if let Some(status) = child
            .0
            .try_wait()
            .map_err(|_| "Не удалось дождаться OpenPrompt.".to_string())?
        {
            break status;
        }
        if Instant::now() >= deadline {
            return Err(timeout());
        }
        thread::sleep(Duration::from_millis(10));
    };
    let out = stdout
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .map_err(|_| timeout())??;
    let _err = stderr
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .map_err(|_| timeout())??;
    if !status.success() {
        return Err("OpenPrompt завершился с ошибкой. Проверьте версию (нужна 0.2 или новее) и доступ к его настройкам.".into());
    }
    String::from_utf8(out).map_err(|_| "OpenPrompt вернул некорректный текст UTF-8.".into())
}

fn discover(configured_path: Option<String>) -> Result<Discovery, String> {
    let mut candidates: Vec<(PathBuf, bool)> = Vec::new();
    if let Some(path) = configured_path.filter(|s| !s.trim().is_empty()) {
        candidates.push((PathBuf::from(path), false));
    } else {
        // A portable install can keep the trusted helper beside OpenTerminal.
        if let Ok(current) = std::env::current_exe() {
            if let Some(directory) = current.parent() {
                for name in ["openprompt.exe", "openprompt"] {
                    candidates.push((directory.join(name), false));
                }
            }
        }
        if let Some(path) = std::env::var_os("PATH") {
            for dir in std::env::split_paths(&path) {
                if !dir.is_absolute() {
                    continue;
                }
                candidates.push((dir.join("openprompt.exe"), false));
                candidates.push((dir.join("openprompt"), false));
            }
        }
        if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
            for name in ["openprompt.exe", "openprompt"] {
                candidates.push((PathBuf::from(&home).join(".cargo/bin").join(name), false));
            }
        }
        // Never embed or search developer checkout paths in packaged release builds.
        #[cfg(debug_assertions)]
        for name in ["openprompt.exe", "openprompt"] {
            candidates.push((
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../openprompt/target/release")
                    .join(name),
                true,
            ));
        }
    }
    let mut error =
        "OpenPrompt не найден. Установите OpenPrompt 0.2+ или укажите путь к файлу.".to_string();
    for (candidate, dev_fallback) in candidates {
        if !candidate.is_file() {
            continue;
        }
        match executable(&candidate).and_then(|path| {
            let version = run(&path, &["--version"], 2)?;
            if !version
                .trim()
                .to_ascii_lowercase()
                .starts_with("openprompt ")
            {
                return Err("Файл не вернул ожидаемую версию OpenPrompt.".into());
            }
            Ok(Discovery {
                path: path.to_string_lossy().into_owned(),
                version: version.trim().to_string(),
                dev_fallback,
            })
        }) {
            Ok(found) => return Ok(found),
            Err(message) => error = message,
        }
    }
    Err(error)
}

fn session_script(path: &str) -> String {
    format!(
        "Invoke-Expression (& '{}' init powershell | Out-String)\r",
        path.replace('\'', "''")
    )
}

#[tauri::command]
pub async fn discover_openprompt(configured_path: Option<String>) -> Result<Discovery, String> {
    tauri::async_runtime::spawn_blocking(move || discover(configured_path))
        .await
        .map_err(|_| "Ошибка поиска OpenPrompt.".to_string())?
}

#[tauri::command]
pub async fn openprompt_preview(path: String, theme: String) -> Result<Preview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_theme(&theme)?;
        let path = executable(Path::new(&path))?;
        let output = run(&path, &["preview", "--theme", &theme, "--json"], 5)?;
        let preview: Preview = serde_json::from_str(&output)
            .map_err(|_| "Нужен OpenPrompt 0.2+ с поддержкой preview --json.".to_string())?;
        if preview.theme != theme {
            return Err("OpenPrompt вернул другую тему предпросмотра.".into());
        }
        Ok(preview)
    })
    .await
    .map_err(|_| "Ошибка предпросмотра OpenPrompt.".to_string())?
}

#[tauri::command]
pub async fn openprompt_set_theme(path: String, theme: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_theme(&theme)?;
        run(&executable(Path::new(&path))?, &["theme", "set", &theme], 5)?;
        Ok(())
    })
    .await
    .map_err(|_| "Ошибка сохранения темы OpenPrompt.".to_string())?
}

#[tauri::command]
pub async fn openprompt_session_script(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = executable(Path::new(&path))?;
        Ok(session_script(&path.to_string_lossy()))
    })
    .await
    .map_err(|_| "Не удалось подготовить команду OpenPrompt.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn themes_are_allowlisted() {
        for theme in ["minimal", "classic", "blocks"] {
            assert!(validate_theme(theme).is_ok());
        }
        for theme in ["", "Classic", "classic; whoami", "--help"] {
            assert!(validate_theme(theme).is_err());
        }
    }
    #[test]
    fn powershell_path_is_a_literal() {
        assert_eq!(session_script("C:\\User's files\\$x;`test\\openprompt.exe"),
            "Invoke-Expression (& 'C:\\User''s files\\$x;`test\\openprompt.exe' init powershell | Out-String)\r");
    }
    #[test]
    fn rejects_other_executable_names() {
        assert!(executable(Path::new("C:\\Windows\\System32\\cmd.exe")).is_err());
    }
    #[test]
    fn output_is_bounded_and_ansi_is_preserved() {
        let ansi = b"\x1b[32mclassic\x1b[0m".to_vec();
        assert_eq!(
            reader(std::io::Cursor::new(ansi.clone()))
                .recv()
                .unwrap()
                .unwrap(),
            ansi
        );
        assert!(
            reader(std::io::Cursor::new(vec![b'x'; OUTPUT_LIMIT as usize + 1]))
                .recv()
                .unwrap()
                .is_err()
        );
    }
}
