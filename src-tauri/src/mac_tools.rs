use std::{env, path::PathBuf};
use tokio::process::Command;

/// Finder'dan açılan uygulamalarda Homebrew dizini PATH'te olmayabilir.
pub fn set_tool_path(command: &mut Command) {
    let inherited = env::var_os("PATH").unwrap_or_default();
    let mut paths: Vec<PathBuf> = env::split_paths(&inherited).collect();
    paths.extend([PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")]);
    if let Ok(path) = env::join_paths(paths) {
        command.env("PATH", path);
    }
}
