use crate::store;
use serde_json::Value;
use std::{
    fs::{self, File},
    io::{self, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};

const DAYS_TO_KEEP: usize = 7;

fn epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

// Convert complete UTC days since the Unix epoch to a Gregorian date.
fn date_at(secs: u64) -> String {
    let days = (secs / 86_400) as i64 + 719_468;
    let era = days / 146_097;
    let day_of_era = days % 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_from_march = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_from_march + 2) / 5 + 1;
    let month = if month_from_march < 10 {
        month_from_march + 3
    } else {
        month_from_march - 9
    };
    let year = era * 400 + year_of_era + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

fn timestamp(secs: u64) -> String {
    format!(
        "{}-{:02}{:02}{:02}",
        date_at(secs).replace('-', ""),
        secs / 3600 % 24,
        secs / 60 % 60,
        secs % 60
    )
}

fn is_day(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() == 10
        && b.iter().enumerate().all(|(i, c)| {
            if [4, 7].contains(&i) {
                *c == b'-'
            } else {
                c.is_ascii_digit()
            }
        })
}

fn backup_files(dir: &Path, prefix: &str) -> Result<Vec<String>, String> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
            continue;
        }
        let name = entry.file_name();
        if let Some(date) = name
            .to_str()
            .and_then(|s| s.strip_prefix(prefix))
            .and_then(|s| s.strip_suffix(".json"))
        {
            if is_day(date) || is_restore_id(date) {
                names.push(date.to_owned());
            }
        }
    }
    names.sort_unstable_by(|a, b| b.cmp(a));
    Ok(names)
}

fn is_restore_id(id: &str) -> bool {
    let Some(rest) = id.strip_prefix("geri-") else {
        return false;
    };
    rest.len() == 21
        && rest.bytes().enumerate().all(|(i, c)| {
            if [8, 15].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

fn daily_at(dir: &Path, prefix: &str, bytes: &[u8], secs: u64) -> Result<(), String> {
    let day = date_at(secs);
    let path = dir.join(format!("{prefix}{day}.json"));
    if !path.exists() {
        store::write_atomic(&path, bytes)?;
    }
    for date in backup_files(dir, prefix)?
        .into_iter()
        .filter(|name| is_day(name))
        .skip(DAYS_TO_KEEP)
    {
        fs::remove_file(dir.join(format!("{prefix}{date}.json"))).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn daily_project(dir: &Path, bytes: &[u8]) {
    if daily_at(&dir.join("backups"), "", bytes, epoch_secs()).is_err() {
        log::warn!(target: "script_store", "project_snapshot_failed");
    }
}

pub fn daily_settings(bytes: &[u8]) {
    if daily_at(
        &store::root().join("backups"),
        "settings-",
        bytes,
        epoch_secs(),
    )
    .is_err()
    {
        log::warn!(target: "script_store", "settings_snapshot_failed");
    }
}

fn target(project_id: Option<&str>) -> Result<(PathBuf, &'static str, PathBuf), String> {
    if let Some(id) = project_id {
        let project = store::project_dir(id)?;
        Ok((project.join("backups"), "", project.join("project.json")))
    } else {
        Ok((
            store::root().join("backups"),
            "settings-",
            store::settings_path(),
        ))
    }
}

#[tauri::command]
pub fn list_backups(project_id: Option<String>) -> Result<Vec<String>, String> {
    let _guard = store::lock_data()?;
    let (dir, prefix, _) = target(project_id.as_deref())?;
    backup_files(&dir, prefix)
}

fn restore_from(
    dir: &Path,
    prefix: &str,
    path: &Path,
    project_id: Option<&str>,
    name: &str,
) -> Result<(), String> {
    if !is_day(name) && !is_restore_id(name) {
        return Err("Geçersiz yedek tarihi".into());
    }
    let backup = dir.join(format!("{prefix}{name}.json"));
    if !fs::symlink_metadata(&backup).is_ok_and(|metadata| metadata.file_type().is_file()) {
        return Err("Yedek dosyası bulunamadı".into());
    }
    let bytes = fs::read(backup).map_err(|e| e.to_string())?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "Yedek içeriği okunamadı")?;
    if !value.is_object() || project_id.is_some_and(|id| value["id"].as_str() != Some(id)) {
        return Err("Yedek bu veriyle eşleşmiyor".into());
    }
    if path.exists() {
        let current = fs::read(path).map_err(|e| e.to_string())?;
        let tag = uuid::Uuid::new_v4().simple().to_string();
        let before = dir.join(format!(
            "{prefix}geri-{}-{}.json",
            timestamp(epoch_secs()),
            &tag[..5]
        ));
        store::write_atomic(&before, &current)?;
    }
    if project_id.is_some() {
        let project_dir = path.parent().ok_or("Proje klasörü bulunamadı")?;
        super::projects::write_project(project_dir, value)?;
    } else {
        store::write_atomic(path, &bytes)?;
    }
    Ok(())
}

#[tauri::command]
pub fn restore_backup(project_id: Option<String>, date: String) -> Result<(), String> {
    let _guard = store::lock_data()?;
    let (dir, prefix, path) = target(project_id.as_deref())?;
    restore_from(&dir, prefix, &path, project_id.as_deref(), &date)
}

type Archive = ZipWriter<File>;

fn append_tree(
    archive: &mut Archive,
    base: &Path,
    dir: &Path,
    written: &mut Vec<(String, u64)>,
) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let metadata = entry.file_type().map_err(|e| e.to_string())?;
        if metadata.is_symlink() {
            return Err("Proje arşivi sembolik bağlantı içeriyor".into());
        }
        if metadata.is_dir() {
            append_tree(archive, base, &path, written)?;
        } else if metadata.is_file() {
            let name = path
                .strip_prefix(base)
                .map_err(|e| e.to_string())?
                .components()
                .map(|c| {
                    c.as_os_str()
                        .to_str()
                        .filter(|s| !s.contains('\\'))
                        .ok_or("Arşiv yolu kodlanamadı")
                })
                .collect::<Result<Vec<_>, _>>()?
                .join("/");
            archive
                .start_file(
                    &name,
                    SimpleFileOptions::default()
                        .large_file(true)
                        .compression_method(zip::CompressionMethod::Deflated),
                )
                .map_err(|e| e.to_string())?;
            let mut input = File::open(path).map_err(|e| e.to_string())?;
            let bytes = io::copy(&mut input, archive).map_err(|e| e.to_string())?;
            written.push((name, bytes));
        } else {
            return Err("Arşivlenemeyen proje dosyası".into());
        }
    }
    Ok(())
}

fn archive_projects(dir: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination.parent().ok_or("Arşiv klasörü bulunamadı")?)
        .map_err(|e| e.to_string())?;
    let temporary = destination.with_extension("zip.tmp");
    let result = (|| {
        let mut archive = ZipWriter::new(File::create(&temporary).map_err(|e| e.to_string())?);
        let mut written = Vec::new();
        if dir.exists() {
            append_tree(
                &mut archive,
                dir.parent().ok_or("Proje kökü yok")?,
                dir,
                &mut written,
            )?;
        }
        let file = archive.finish().map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        let mut check = ZipArchive::new(File::open(&temporary).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        if check.len() != written.len() {
            return Err("Arşiv dosya sayısı doğrulanamadı".into());
        }
        for (name, size) in written {
            let mut entry = check.by_name(&name).map_err(|e| e.to_string())?;
            if io::copy(&mut entry, &mut io::sink()).map_err(|e| e.to_string())? != size {
                return Err("Arşiv dosya içeriği doğrulanamadı".into());
            }
        }
        drop(check);
        fs::rename(&temporary, destination).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

pub fn archive_and_clear(dir: &Path, backups: &Path) -> Result<String, String> {
    let tag = uuid::Uuid::new_v4().simple().to_string();
    let name = format!("full-{}-{}.zip", timestamp(epoch_secs()), &tag[..8]);
    let archive = backups.join(&name);
    archive_projects(dir, &archive)?;
    if dir.exists() {
        let moved = dir.with_file_name(format!("projects-cleared-{tag}"));
        fs::rename(dir, &moved)
            .map_err(|e| format!("Yedek oluşturuldu, proje klasörü taşınamadı: {e}"))?;
        if let Err(error) = fs::create_dir_all(dir) {
            fs::rename(&moved, dir).map_err(|e| format!("Proje klasörü geri taşınamadı: {e}"))?;
            return Err(error.to_string());
        }
        if fs::remove_dir_all(&moved).is_err() {
            log::warn!(target: "script_store", "cleared_projects_cleanup_failed");
        }
    } else {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    Ok(archive.to_string_lossy().into_owned())
}

pub fn write_diagnostics(path: &Path, values: &[(String, Vec<u8>)]) -> Result<(), String> {
    let tmp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4().simple()));
    let result = (|| {
        let mut archive = ZipWriter::new(File::create(&tmp).map_err(|e| e.to_string())?);
        for (name, bytes) in values {
            archive
                .start_file(
                    name,
                    SimpleFileOptions::default()
                        .compression_method(zip::CompressionMethod::Deflated),
                )
                .map_err(|e| e.to_string())?;
            archive.write_all(bytes).map_err(|e| e.to_string())?;
        }
        archive
            .finish()
            .map_err(|e| e.to_string())?
            .sync_all()
            .map_err(|e| e.to_string())?;
        fs::rename(&tmp, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_daily_backup_retains_seven_and_restore_preserves_previous_contents() {
        let tmp = std::env::temp_dir().join(uuid::Uuid::new_v4().simple().to_string());
        let backups = tmp.join("backups");
        for day in 0..9 {
            daily_at(&backups, "settings-", br#"{"wpm":160}"#, day * 86_400).unwrap();
            daily_at(&backups, "settings-", br#"{"wpm":220}"#, day * 86_400).unwrap();
        }
        let files = backup_files(&backups, "settings-").unwrap();
        assert_eq!(files.len(), 7);
        assert_eq!(files[0], "1970-01-09");
        assert_eq!(date_at(1_709_164_800), "2024-02-29");
        let settings = tmp.join("settings.json");
        store::write_atomic(&settings, br#"{"wpm":200}"#).unwrap();
        restore_from(&backups, "settings-", &settings, None, &files[0]).unwrap();
        assert_eq!(fs::read(&settings).unwrap(), br#"{"wpm":160}"#);
        let undo = backup_files(&backups, "settings-")
            .unwrap()
            .into_iter()
            .find(|s| is_restore_id(s))
            .unwrap();
        restore_from(&backups, "settings-", &settings, None, &undo).unwrap();
        assert_eq!(fs::read(&settings).unwrap(), br#"{"wpm":200}"#);
        assert!(restore_from(&backups, "settings-", &settings, None, "../../settings").is_err());
        fs::remove_dir_all(tmp).unwrap();
    }

    #[test]
    fn clear_archives_project_json_and_complete_media_before_removal() {
        let tmp = std::env::temp_dir().join(uuid::Uuid::new_v4().simple().to_string());
        let dir = tmp.join("projects");
        let backups = tmp.join("backups");
        let project = dir.join("id");
        store::write_atomic(&project.join("project.json"), br#"{"id":"id"}"#).unwrap();
        store::write_atomic(&project.join("images/shot.png"), b"image").unwrap();
        store::write_atomic(&project.join("voice/take.webm"), b"audio").unwrap();
        assert!(archive_and_clear(&dir, &project.join("project.json")).is_err());
        assert!(project.join("images/shot.png").exists());
        let path = archive_and_clear(&dir, &backups).unwrap();
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
        let mut zip = ZipArchive::new(File::open(path).unwrap()).unwrap();
        assert_eq!(zip.len(), 3);
        for (name, expected) in [("images/shot.png", b"image"), ("voice/take.webm", b"audio")] {
            let mut bytes = Vec::new();
            io::copy(
                &mut zip.by_name(&format!("projects/id/{name}")).unwrap(),
                &mut bytes,
            )
            .unwrap();
            assert_eq!(bytes, expected);
        }
        drop(zip);
        fs::remove_dir_all(tmp).unwrap();
    }
}
