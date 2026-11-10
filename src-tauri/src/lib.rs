mod prompt;
mod terminal;

use tauri::Manager;
use terminal::TerminalManager;

pub fn run() {
    let app = tauri::Builder::default()
        .manage(TerminalManager::default())
        .invoke_handler(tauri::generate_handler![
            terminal::create_terminal,
            terminal::write_terminal,
            terminal::resize_terminal,
            terminal::close_terminal,
            prompt::discover_openprompt,
            prompt::openprompt_preview,
            prompt::openprompt_set_theme,
            prompt::openprompt_session_script,
        ])
        .build(tauri::generate_context!())
        .expect("Could not start OpenTerminal");

    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            handle.state::<TerminalManager>().close_all();
        }
    });
}
