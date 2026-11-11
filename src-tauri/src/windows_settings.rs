use serde::Serialize;
use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};

const MAX_SETTINGS_BYTES: u64 = 2 * 1024 * 1024;
const SOURCES: [(&str, &str, &str); 3] = [
    (
        "stable",
        "Windows Terminal",
        "Packages/Microsoft.WindowsTerminal_8wekyb3d8bbwe/LocalState/settings.json",
    ),
    (
        "preview",
        "Windows Terminal Preview",
        "Packages/Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe/LocalState/settings.json",
    ),
    (
        "unpackaged",
        "Windows Terminal (unpackaged)",
        "Microsoft/Windows Terminal/settings.json",
    ),
];

#[derive(Serialize)]
pub struct WindowsTerminalSettingsSource {
    id: String,
    label: String,
}

fn source_path(local_app_data: &Path, id: &str) -> Result<PathBuf, String> {
    SOURCES
        .iter()
        .find(|(known, _, _)| *known == id)
        .map(|(_, _, relative)| local_app_data.join(relative))
        .ok_or_else(|| "Unknown Windows Terminal settings source".into())
}

fn decode_settings(reader: impl Read) -> Result<String, String> {
    let mut bytes = Vec::new();
    reader
        .take(MAX_SETTINGS_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_SETTINGS_BYTES {
        return Err("Windows Terminal settings exceed 2 MiB".into());
    }
    let text = String::from_utf8(bytes)
        .map_err(|_| "Windows Terminal settings must be UTF-8".to_string())?;
    Ok(text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned())
}

fn read_source(local_app_data: &Path, id: &str) -> Result<String, String> {
    // Follow user-managed links, but inspect and bound reads on the same open file.
    let file = File::open(source_path(local_app_data, id)?).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err("Windows Terminal settings are not a regular file".into());
    }
    if metadata.len() > MAX_SETTINGS_BYTES {
        return Err("Windows Terminal settings exceed 2 MiB".into());
    }
    decode_settings(file)
}

#[tauri::command]
pub async fn list_windows_terminal_settings() -> Result<Vec<WindowsTerminalSettingsSource>, String>
{
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(|| {
            let Some(root) = std::env::var_os("LOCALAPPDATA") else {
                return Ok(Vec::new());
            };
            let root = PathBuf::from(root);
            Ok(SOURCES
                .iter()
                .filter(|(id, _, _)| source_path(&root, id).is_ok_and(|path| path.is_file()))
                .map(|(id, label, _)| WindowsTerminalSettingsSource {
                    id: (*id).into(),
                    label: (*label).into(),
                })
                .collect())
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    {
        Ok(Vec::new())
    }
}

#[tauri::command]
pub async fn read_windows_terminal_settings(id: String) -> Result<String, String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            let root = std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA is unavailable")?;
            read_source(Path::new(&root), &id)
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = id;
        Err("Windows Terminal settings are available on Windows only".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_fixed_source_ids_resolve() {
        let root = Path::new("fixture-local-app-data");
        for (id, _, relative) in SOURCES {
            assert_eq!(source_path(root, id).unwrap(), root.join(relative));
        }
        for id in [
            "",
            "../settings.json",
            "stable/../preview",
            "C:\\secrets.json",
            "STABLE",
        ] {
            assert!(source_path(root, id).is_err());
        }
    }

    #[test]
    fn raw_jsonc_and_optional_utf8_bom_are_preserved() {
        let jsonc = "// comment\n{\"profiles\": [],}";
        assert_eq!(decode_settings(jsonc.as_bytes()).unwrap(), jsonc);
        assert_eq!(
            decode_settings(format!("\u{feff}{jsonc}").as_bytes()).unwrap(),
            jsonc
        );
        assert!(decode_settings(&[0xff][..]).is_err());
    }

    #[test]
    fn size_limit_is_enforced_even_for_growing_or_unknown_length_readers() {
        assert_eq!(
            decode_settings(std::io::repeat(b' ').take(MAX_SETTINGS_BYTES))
                .unwrap()
                .len(),
            MAX_SETTINGS_BYTES as usize
        );
        assert!(decode_settings(std::io::repeat(b' ')).is_err());
    }

    #[test]
    fn invalid_id_is_rejected_before_opening_any_file() {
        assert_eq!(
            read_source(Path::new("nonexistent-fixture"), "../secret").unwrap_err(),
            "Unknown Windows Terminal settings source"
        );
    }
}
