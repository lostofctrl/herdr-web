mod agent_activity;
mod agent_pins;
mod git_status;
mod launcher_presets;
mod note_images;
mod notes;
mod pi_sidepanel_buttons;
mod session;
mod sidebar_config;
mod store_util;
mod web_bridge;
mod websocket_heartbeat;
mod workspace;

fn main() -> std::io::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(web_bridge::run_command(&args)?);
}
