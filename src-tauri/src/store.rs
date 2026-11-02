//! The saved session. Nothing here is ever sent to the webview.

use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::Path};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Token {
    pub access: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Store {
    #[serde(default)]
    pub user: Option<Token>,
}

impl Store {
    pub fn load(path: &Path) -> Self {
        fs::read(path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    /// Atomic and owner-only: a torn write would log the user out.
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let dir = path.parent().expect("store path has a parent");
        fs::create_dir_all(dir)?;
        let tmp = path.with_extension("tmp");
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp)?;
        f.write_all(&serde_json::to_vec_pretty(self)?)?;
        f.sync_all()?;
        fs::rename(&tmp, path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrips_with_private_permissions() {
        let dir = std::env::temp_dir().join(format!("sound95-test-{}", std::process::id()));
        let path = dir.join("session.json");
        let store = Store {
            user: Some(Token { access: "a".into() }),
        };
        store.save(&path).unwrap();
        assert!(Store::load(&path).user.is_some());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn missing_file_is_logged_off() {
        assert!(Store::load(Path::new("/nonexistent/sound95"))
            .user
            .is_none());
    }
}
