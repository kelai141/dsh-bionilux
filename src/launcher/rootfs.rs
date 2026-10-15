//! Guest path semantics.
//!
//! One mapping function, used by every caller, so the launcher and the
//! preload hook cannot disagree about what `/usr/bin/bash` means.
//!
//! The rules ([docs/ROOTFS.md](../../docs/ROOTFS.md)):
//!
//! * `/x` inside a configured rootfs means `<rootfs>/x`.
//! * A guest path that does not exist inside the rootfs fails with `ENOENT`.
//!   It never falls back to the host's identically named path.
//! * Paths that belong to the host by definition — `/proc`, `/sys`, `/dev`
//!   and anything already living under the rootfs or the launcher's own
//!   install prefix — pass through untouched. Mapping them would either
//!   double the prefix or hide kernel file systems the guest needs.

use std::path::{Path, PathBuf};

use crate::launcher::config::{Config, join_guest, normalize};

/// Prefixes that always resolve against the host kernel, never the rootfs.
/// `/dev/shm` is deliberately absent: Android has no tmpfs shm mount, so a
/// rootfs-hosted directory is the only way to make POSIX shm work.
const HOST_VIRTUAL_PREFIXES: &[&str] = &["/proc", "/sys", "/dev"];

/// Exceptions inside the host virtual prefixes that should be mapped anyway.
const HOST_VIRTUAL_EXCEPTIONS: &[&str] = &["/dev/shm"];

/// Returns `true` when `path` is exactly `prefix` or lives directly below it.
fn under_prefix(path: &str, prefix: &str) -> bool {
    if !path.starts_with(prefix) {
        return false;
    }
    path.len() == prefix.len() || path.as_bytes()[prefix.len()] == b'/'
}

/// A configured rootfs, or its absence.
#[derive(Debug, Clone)]
pub struct Rootfs {
    root: Option<PathBuf>,
    /// Host directories that must never be remapped.
    host_dirs: Vec<PathBuf>,
    /// When set, a missing guest path falls back to the host path. This is a
    /// debugging aid for differential testing, never the production default.
    lenient: bool,
}

impl Rootfs {
    pub fn from_config(cfg: &Config) -> Self {
        let mut host_dirs = Vec::new();
        host_dirs.extend(cfg.prefix.clone());
        host_dirs.extend(cfg.runtime_dir.clone());
        // Android paths the guest reaches natively (public storage, the app's
        // own private directory): no rootfs prefix, no guest-side mapping.
        host_dirs.extend(cfg.host_paths.iter().cloned());
        Rootfs {
            root: cfg.rootfs.clone(),
            host_dirs,
            lenient: cfg.lenient,
        }
    }

    pub fn current() -> &'static Self {
        static CACHE: std::sync::OnceLock<Rootfs> = std::sync::OnceLock::new();
        CACHE.get_or_init(|| Rootfs::from_config(crate::launcher::config::config()))
    }

    pub fn enabled(&self) -> bool {
        self.root.is_some()
    }

    /// `true` when the guest path must be handed to the kernel unchanged.
    pub fn passthrough(&self, path: &str) -> bool {
        if !path.starts_with('/') {
            return true; // relative paths resolve against an already-physical cwd
        }
        if self.root.is_none() {
            return true; // no rootfs: the host user space is the guest
        }
        let exempt = HOST_VIRTUAL_EXCEPTIONS
            .iter()
            .any(|e| under_prefix(path, e));
        if !exempt && HOST_VIRTUAL_PREFIXES.iter().any(|p| under_prefix(path, p)) {
            return true;
        }
        if let Some(root) = &self.root
            && Path::new(path).starts_with(root)
        {
            return true;
        }
        self.host_dirs.iter().any(|d| {
            let s = d.to_string_lossy();
            under_prefix(path, &s)
        })
    }

    /// The host path that backs `logical`, whether or not it exists yet.
    ///
    /// Callers that open with `O_CREAT` need this: the file does not exist but
    /// the directory it is created in must still belong to the guest.
    pub fn physical(&self, logical: &str) -> PathBuf {
        let Some(root) = &self.root else {
            return PathBuf::from(logical);
        };
        if self.passthrough(logical) {
            return PathBuf::from(logical);
        }
        let physical = join_root(root, &normalize(logical));
        if self.lenient && !physical.exists() {
            return PathBuf::from(logical);
        }
        physical
    }

    /// Map a guest path, requiring that it exists inside the rootfs.
    /// `None` means "no such file in the guest".
    pub fn map_existing(&self, logical: &str) -> Option<String> {
        let physical = self.physical(logical);
        physical
            .exists()
            .then(|| physical.to_string_lossy().into_owned())
    }

    /// Rewrite a host physical path back into the guest's view of it.
    pub fn unmap(&self, physical: &str) -> String {
        let Some(root) = &self.root else {
            return physical.to_string();
        };
        let root_str = root.to_string_lossy();
        if physical == root_str {
            return "/".to_string();
        }
        if let Some(rest) = physical.strip_prefix(&format!("{root_str}/")) {
            return format!("/{rest}");
        }
        physical.to_string()
    }

    /// `true` when `dir` is the guest root or a directory inside it.
    pub fn contains(&self, dir: &Path) -> bool {
        self.root.as_ref().is_some_and(|r| dir.starts_with(r))
    }

    /// Physical directory backing a guest directory, including host passthroughs.
    pub fn dir_for(&self, logical: &str) -> Result<PathBuf, String> {
        let physical = self.physical(&normalize(logical));
        if physical.is_dir() {
            Ok(physical)
        } else {
            Err(format!(
                "working directory does not exist or is not a directory: {logical}"
            ))
        }
    }

    /// Search the guest `PATH` for `name`, mirroring `execvp` semantics:
    /// an empty entry means the current directory.
    pub fn search(&self, name: &str, guest_cwd: &str, guest_path: &[String]) -> Option<PathBuf> {
        let dirs: Vec<String> = if guest_path.is_empty() {
            vec![guest_cwd.to_string()]
        } else {
            guest_path
                .iter()
                .map(|d| {
                    if d.is_empty() {
                        guest_cwd.to_string()
                    } else if d.starts_with('/') {
                        d.clone()
                    } else {
                        join_guest(guest_cwd, d)
                    }
                })
                .collect()
        };
        for dir in dirs {
            let candidate = normalize(&join_guest(&dir, name));
            let physical = self.physical(&candidate);
            if is_executable(&physical) {
                return Some(physical);
            }
        }
        None
    }
}

fn join_root(root: &Path, logical: &str) -> PathBuf {
    let trimmed = logical.trim_start_matches('/');
    if trimmed.is_empty() {
        root.to_path_buf()
    } else {
        root.join(trimmed)
    }
}

#[cfg(unix)]
pub fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
        && nix::unistd::access(path, nix::unistd::AccessFlags::X_OK).is_ok()
}

#[cfg(not(unix))]
pub fn is_executable(path: &Path) -> bool {
    path.is_file()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::launcher::config;
    use std::fs;

    fn rootfs_with(entries: &[&str]) -> (tempfile::TempDir, Rootfs) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("rootfs");
        for rel in entries {
            let p = root.join(rel.trim_start_matches('/'));
            if rel.ends_with('/') {
                fs::create_dir_all(&p).unwrap();
            } else {
                fs::create_dir_all(p.parent().unwrap()).unwrap();
                fs::write(&p, b"x").unwrap();
                let mut perms = fs::metadata(&p).unwrap().permissions();
                use std::os::unix::fs::PermissionsExt;
                perms.set_mode(0o755);
                fs::set_permissions(&p, perms).unwrap();
            }
        }
        let cfg = Config {
            prefix: None,
            runtime_dir: None,
            rootfs: Some(root),
            box64: None,
            preload: None,
            loader: None,
            guest_path: config::split_path_list(config::GUEST_PATH_DEFAULT),
            guest_home: "/root".into(),
            guest_tmp: "/tmp".into(),
            guest_cwd: "/".into(),
            argv0: None,
            fake_root: true,
            lenient: false,
            host_paths: Vec::new(),
        };
        let rf = Rootfs::from_config(&cfg);
        (tmp, rf)
    }

    fn root(rf: &Rootfs) -> String {
        rf.root.as_ref().unwrap().to_string_lossy().into_owned()
    }

    #[test]
    fn maps_existing_absolute_path_into_rootfs() {
        let (_t, rf) = rootfs_with(&["/usr/bin/bash"]);
        let mapped = rf.map_existing("/usr/bin/bash").unwrap();
        assert!(mapped.starts_with(&root(&rf)));
        assert!(mapped.ends_with("usr/bin/bash"));
    }

    #[test]
    fn missing_path_stays_inside_rootfs_instead_of_host() {
        let (_t, rf) = rootfs_with(&["/usr/bin/bash"]);
        // /bin/sh does not exist inside this rootfs. It must not resolve to
        // the host's /bin/sh.
        assert!(rf.map_existing("/bin/sh").is_none());
        let physical = rf.physical("/bin/sh");
        assert!(
            physical.starts_with(root(&rf)),
            "physical path escaped the rootfs: {}",
            physical.display()
        );
    }

    #[test]
    fn physical_path_for_o_creat_target() {
        let (_t, rf) = rootfs_with(&["/etc/"]);
        // The file does not exist yet but must be created inside the guest.
        let target = rf.physical("/etc/motd");
        assert!(target.starts_with(root(&rf)));
        assert!(target.ends_with("etc/motd"));
    }

    #[test]
    fn host_virtual_filesystems_pass_through() {
        let (_t, rf) = rootfs_with(&["/proc/"]);
        for p in [
            "/proc/self/exe",
            "/sys/class/net",
            "/dev/null",
            "/dev/urandom",
        ] {
            assert!(rf.passthrough(p), "{p} should pass through");
            assert_eq!(rf.physical(p).to_string_lossy(), p);
        }
    }

    #[test]
    fn dev_shm_is_mapped_so_posix_shm_works() {
        let (_t, rf) = rootfs_with(&["/dev/shm/"]);
        assert!(!rf.passthrough("/dev/shm/foo"));
        assert!(rf.physical("/dev/shm/foo").starts_with(root(&rf)));
    }

    #[test]
    fn already_physical_paths_are_not_double_prefixed() {
        let (_t, rf) = rootfs_with(&["/usr/bin/bash"]);
        let physical = rf.physical("/usr/bin/bash");
        assert_eq!(rf.physical(&physical.to_string_lossy()), physical);
    }

    #[test]
    fn unmap_round_trips() {
        let (_t, rf) = rootfs_with(&["/usr/bin/bash"]);
        let physical = rf.physical("/usr/bin/bash");
        assert_eq!(rf.unmap(&physical.to_string_lossy()), "/usr/bin/bash");
        assert_eq!(rf.unmap(&root(&rf)), "/");
    }

    #[test]
    fn unmap_leaves_foreign_paths_alone() {
        let (_t, rf) = rootfs_with(&["/usr/bin/bash"]);
        assert_eq!(rf.unmap("/proc/self/exe"), "/proc/self/exe");
    }

    #[test]
    fn dot_segments_cannot_escape_the_rootfs() {
        let (_t, rf) = rootfs_with(&["/etc/os-release"]);
        let physical = rf.physical("/../../../../etc/os-release");
        assert!(
            physical.starts_with(root(&rf)),
            "escaped: {}",
            physical.display()
        );
        assert!(physical.ends_with("etc/os-release"));
    }

    #[test]
    fn search_uses_guest_path_order_and_skips_non_executables() {
        let (_t, rf) = rootfs_with(&["/usr/bin/bash", "/bin/dash"]);
        let path = config::split_path_list(config::GUEST_PATH_DEFAULT);
        let found = rf.search("bash", "/", &path).unwrap();
        assert!(found.to_string_lossy().ends_with("usr/bin/bash"));
        assert!(rf.search("nope", "/", &path).is_none());
    }

    #[test]
    fn search_preserves_empty_and_relative_path_entries() {
        let (_t, rf) = rootfs_with(&["/work/local-tool", "/work/tools/relative-tool"]);
        assert!(
            rf.search("local-tool", "/work", &config::split_path_list(":/bin"))
                .unwrap()
                .ends_with("work/local-tool")
        );
        assert!(
            rf.search(
                "relative-tool",
                "/work",
                &config::split_path_list("tools:/bin")
            )
            .unwrap()
            .ends_with("work/tools/relative-tool")
        );
        assert!(
            rf.search("local-tool", "/work", &config::split_path_list("/bin:"))
                .is_some()
        );
    }

    #[test]
    fn cwd_uses_host_passthrough_and_rejects_missing_directories() {
        let (tmp, mut rf) = rootfs_with(&["/work/"]);
        let host = tmp.path().join("host-workspace");
        fs::create_dir(&host).unwrap();
        rf.host_dirs.push(host.clone());
        assert_eq!(rf.dir_for(host.to_str().unwrap()).unwrap(), host);
        assert_eq!(rf.dir_for("/work").unwrap(), rf.physical("/work"));
        assert!(rf.dir_for("/missing").is_err());
    }

    #[test]
    fn executable_check_rejects_readable_scripts_without_execute_bits() {
        let (_t, rf) = rootfs_with(&["/script"]);
        let script = rf.physical("/script");
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&script, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(!is_executable(&script));
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(is_executable(&script));
    }

    #[test]
    fn disabled_rootfs_is_transparent() {
        let cfg = Config {
            prefix: None,
            runtime_dir: None,
            rootfs: None,
            box64: None,
            preload: None,
            loader: None,
            guest_path: vec![],
            guest_home: "/root".into(),
            guest_tmp: "/tmp".into(),
            guest_cwd: "/".into(),
            argv0: None,
            fake_root: false,
            lenient: false,
            host_paths: Vec::new(),
        };
        let rf = Rootfs::from_config(&cfg);
        assert!(!rf.enabled());
        assert_eq!(
            rf.physical("/usr/bin/bash").to_string_lossy(),
            "/usr/bin/bash"
        );
        assert_eq!(rf.unmap("/usr/bin/bash"), "/usr/bin/bash");
        assert!(rf.passthrough("/usr/bin/bash"));
    }

    #[test]
    fn lenient_mode_falls_back_to_host_for_debugging() {
        let cfg = Config {
            prefix: None,
            runtime_dir: None,
            rootfs: Some(PathBuf::from("/nonexistent-rootfs-xyz")),
            box64: None,
            preload: None,
            loader: None,
            guest_path: vec![],
            guest_home: "/root".into(),
            guest_tmp: "/tmp".into(),
            guest_cwd: "/".into(),
            argv0: None,
            fake_root: false,
            lenient: true,
            host_paths: Vec::new(),
        };
        let rf = Rootfs::from_config(&cfg);
        assert_eq!(rf.physical("/etc/hosts").to_string_lossy(), "/etc/hosts");
    }

    #[test]
    fn android_host_paths_keep_their_native_meaning() {
        let cfg = Config {
            prefix: None,
            runtime_dir: None,
            rootfs: Some(PathBuf::from("/rootfs")),
            box64: None,
            preload: None,
            loader: None,
            guest_path: vec![],
            guest_home: "/root".into(),
            guest_tmp: "/tmp".into(),
            guest_cwd: "/".into(),
            argv0: None,
            fake_root: false,
            lenient: false,
            host_paths: vec![PathBuf::from("/sdcard")],
        };
        let rf = Rootfs::from_config(&cfg);

        // Public storage is reached the way Android reaches it.
        assert!(rf.passthrough("/sdcard"));
        assert!(rf.passthrough("/sdcard/DCIM/photo.jpg"));
        assert_eq!(
            rf.physical("/sdcard/DCIM/photo.jpg").to_string_lossy(),
            "/sdcard/DCIM/photo.jpg"
        );

        // A sibling with a shared prefix is not part of it, and everything
        // else still belongs to the guest.
        assert!(!rf.passthrough("/sdcardx"));
        assert!(!rf.passthrough("/etc/hosts"));
        assert_eq!(
            rf.physical("/etc/hosts").to_string_lossy(),
            "/rootfs/etc/hosts"
        );
    }
}
