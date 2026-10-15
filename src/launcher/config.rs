//! Runtime configuration.
//!
//! Every value is derived from the environment, so the launcher can be
//! embedded as a component of another application (DSH Mobile) without
//! hardcoding Termux or any other host package path. Literal defaults exist
//! only for guest-visible values that have a well-defined Linux meaning.
//!
//! Configuration sources, in order of precedence:
//!
//! 1. Command line flags (`--rootfs`, `--guest-cwd`, `--guest-path`).
//! 2. `BIONILUX_*` environment variables.
//! 3. Generic environment (e.g. `PREFIX` on Termux).
//!
//! See docs/HARDCODING.md for the full list.

use std::env;
use std::path::PathBuf;
use std::sync::OnceLock;

/// Debian's standard `PATH`. Also the correct default for any glibc rootfs.
pub const GUEST_PATH_DEFAULT: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/// Guest home directory. Standard for the (faked) root user.
pub const GUEST_HOME_DEFAULT: &str = "/root";

/// Guest temp directory, as prescribed by FHS.
pub const GUEST_TMP_DEFAULT: &str = "/tmp";

/// Guest working directory used when the host cwd is not inside the rootfs.
pub const GUEST_CWD_DEFAULT: &str = "/";

/// Environment variables that leak the host user space into the guest and are
/// therefore removed before the guest is started.
const HOST_ENV_LEAKS: &[&str] = &[
    "PREFIX",
    "TERMUX_VERSION",
    "TERMUX_APP_PID",
    "TERMUX_MAIN_PACKAGE_FORMAT",
    "TERMUX_APK_RELEASE",
];

/// Per-architecture runtime facts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Arch {
    Aarch64,
    X86_64,
}

impl Arch {
    pub fn from_machine(machine: u16) -> Option<Self> {
        match machine {
            crate::analyzer::elf::EM_AARCH64 => Some(Arch::Aarch64),
            crate::analyzer::elf::EM_X86_64 => Some(Arch::X86_64),
            _ => None,
        }
    }

    /// The host this launcher was compiled for.
    pub fn host() -> Self {
        match env::consts::ARCH {
            "x86_64" => Arch::X86_64,
            _ => Arch::Aarch64,
        }
    }

    /// Debian's multiarch triplet, used for `/lib/<triplet>` and friends.
    pub fn triplet(self) -> &'static str {
        match self {
            Arch::Aarch64 => "aarch64-linux-gnu",
            Arch::X86_64 => "x86_64-linux-gnu",
        }
    }

    /// File name of the glibc loader shipped in a Linux rootfs.
    pub fn loader_name(self) -> &'static str {
        match self {
            Arch::Aarch64 => "ld-linux-aarch64.so.1",
            Arch::X86_64 => "ld-linux-x86-64.so.2",
        }
    }

    /// Directories a Debian rootfs keeps its shared libraries in, relative to
    /// the rootfs. Order matters: it mirrors the loader's own search order.
    pub fn lib_dirs(self) -> &'static [&'static str] {
        match self {
            Arch::Aarch64 => &["/lib/aarch64-linux-gnu", "/usr/lib/aarch64-linux-gnu"],
            Arch::X86_64 => &[
                "/lib/x86_64-linux-gnu",
                "/usr/lib/x86_64-linux-gnu",
                "/lib64",
            ],
        }
    }
}

/// Fully resolved runtime configuration.
#[derive(Debug)]
pub struct Config {
    /// Host install prefix used to locate the launcher's own glibc runtime.
    /// `None` when the host does not provide one (rootfs-only setups).
    pub prefix: Option<PathBuf>,
    /// Directory holding the launcher's glibc (`lib/ld-linux-*.so.1`,
    /// `etc/`, ...). Only used when no rootfs loader is available.
    pub runtime_dir: Option<PathBuf>,
    /// Guest file system root. `None` disables rootfs path semantics.
    pub rootfs: Option<PathBuf>,
    /// Explicit box64 binary, only consulted for cross-architecture targets.
    pub box64: Option<PathBuf>,
    /// Explicit preload library path.
    pub preload: Option<PathBuf>,
    /// Explicit loader path, overriding both rootfs and runtime-dir lookup.
    pub loader: Option<PathBuf>,
    /// Guest `PATH`, used for program lookup and exported to the guest.
    pub guest_path: Vec<String>,
    pub guest_home: String,
    pub guest_tmp: String,
    /// Guest working directory for the initial launch.
    pub guest_cwd: String,
    /// Whether to report uid/gid 0 and turn ownership changes into no-ops.
    /// Required for `apt`/`dpkg`, which refuse to run as a non-root user.
    pub fake_root: bool,
    /// When a path is missing inside the rootfs, fall back to the host path
    /// instead of failing. Off by default: the guest must not see host paths.
    pub lenient: bool,
}

impl Config {
    pub fn from_env() -> Self {
        let prefix = env_path("BIONILUX_PREFIX").or_else(|| {
            env::var_os("PREFIX")
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
        });

        let runtime_dir =
            env_path("BIONILUX_RUNTIME_DIR").or_else(|| prefix.as_ref().map(|p| p.join("glibc")));

        let rootfs = env_path("BIONILUX_ROOTFS").filter(|p| p.is_dir());

        let box64 = env_path("BIONILUX_BOX64")
            .or_else(|| prefix.as_ref().map(|p| p.join("bionilux/box64-glibc")))
            .or_else(|| {
                runtime_dir
                    .as_ref()
                    .map(|p| p.join("../bionilux/box64-glibc"))
            });

        // A Debian user space is expected to be able to run apt/dpkg, which
        // refuse to work as a non-root user.
        let fake_root = env_bool("BIONILUX_FAKE_ROOT").unwrap_or(rootfs.is_some());

        Config {
            prefix,
            runtime_dir,
            rootfs,
            box64,
            preload: env_path(env_keys::PRELOAD),
            loader: env_path(env_keys::LOADER),
            guest_path: env_str("BIONILUX_GUEST_PATH")
                .map(|s| split_path_list(&s))
                .unwrap_or_else(|| split_path_list(GUEST_PATH_DEFAULT)),
            guest_home: env_str("BIONILUX_GUEST_HOME").unwrap_or_else(|| GUEST_HOME_DEFAULT.into()),
            guest_tmp: env_str("BIONILUX_GUEST_TMP").unwrap_or_else(|| GUEST_TMP_DEFAULT.into()),
            guest_cwd: env_str("BIONILUX_GUEST_CWD").unwrap_or_else(|| GUEST_CWD_DEFAULT.into()),
            fake_root,
            lenient: env_bool("BIONILUX_LENIENT").unwrap_or(false),
        }
    }
}

/// Process-wide configuration. Read once so the environment cannot shift
/// under a running resolution.
pub fn config() -> &'static Config {
    static CACHE: OnceLock<Config> = OnceLock::new();
    CACHE.get_or_init(Config::from_env)
}

/// Split a `PATH`-style list, dropping empty entries.
pub fn split_path_list(value: &str) -> Vec<String> {
    value
        .split(':')
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect()
}

/// Join a guest directory and a relative name, avoiding a doubled slash.
pub fn join_guest(dir: &str, name: &str) -> String {
    if name.starts_with('/') {
        return name.to_string();
    }
    if dir == "/" || dir.is_empty() {
        format!("/{name}")
    } else {
        format!("{}/{name}", dir.trim_end_matches('/'))
    }
}

/// Lexically normalize `..` and `.` segments. Symlinks are *not* followed —
/// the kernel does that later, using the mapped physical path.
pub fn normalize(path: &str) -> String {
    let absolute = path.starts_with('/');
    let mut out: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if out.last().is_some_and(|p| *p != "..") {
                    out.pop();
                } else if !absolute {
                    out.push("..");
                }
            }
            p => out.push(p),
        }
    }
    let joined = out.join("/");
    match (absolute, joined.is_empty()) {
        (true, _) => format!("/{joined}"),
        (false, true) => ".".into(),
        (false, false) => joined,
    }
}

/// The environment variable names the launcher exports to guest processes.
/// Kept in one place so the launcher and the preload hook cannot drift apart.
pub mod env_keys {
    pub const ROOTFS: &str = "BIONILUX_ROOTFS";
    pub const PREFIX: &str = "BIONILUX_PREFIX";
    pub const RUNTIME_DIR: &str = "BIONILUX_RUNTIME_DIR";
    pub const BOX64: &str = "BIONILUX_BOX64";
    pub const PRELOAD: &str = "BIONILUX_PRELOAD";
    pub const LOADER: &str = "BIONILUX_LOADER";
    pub const GUEST_PATH: &str = "BIONILUX_GUEST_PATH";
    pub const GUEST_HOME: &str = "BIONILUX_GUEST_HOME";
    pub const GUEST_TMP: &str = "BIONILUX_GUEST_TMP";
    pub const GUEST_CWD: &str = "BIONILUX_GUEST_CWD";
    pub const FAKE_ROOT: &str = "BIONILUX_FAKE_ROOT";
    pub const LENIENT: &str = "BIONILUX_LENIENT";
    pub const BINARY_PATH: &str = "BIONILUX_BINARY_PATH";
    pub const TARGET_EXE: &str = "BIONILUX_TARGET_EXE";
}

/// Names stripped from the guest environment.
pub fn host_env_leaks() -> &'static [&'static str] {
    HOST_ENV_LEAKS
}

fn env_str(key: &str) -> Option<String> {
    env::var_os(key)
        .filter(|v| !v.is_empty())
        .map(|v| v.to_string_lossy().into_owned())
}

fn env_path(key: &str) -> Option<PathBuf> {
    env_str(key).map(PathBuf::from)
}

fn env_bool(key: &str) -> Option<bool> {
    let v = env_str(key)?;
    match v.to_ascii_lowercase().as_str() {
        "" | "0" | "false" | "no" | "off" => Some(false),
        _ => Some(true),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_path_list_drops_empty_entries() {
        assert_eq!(split_path_list("/a::/b:"), vec!["/a", "/b"]);
        assert!(split_path_list("").is_empty());
    }

    #[test]
    fn join_guest_handles_root_and_trailing_slash() {
        assert_eq!(join_guest("/", "bin"), "/bin");
        assert_eq!(join_guest("/usr", "bin"), "/usr/bin");
        assert_eq!(join_guest("/usr/", "bin"), "/usr/bin");
        assert_eq!(join_guest("/usr", "/etc"), "/etc");
    }

    #[test]
    fn normalize_resolves_dot_segments() {
        assert_eq!(normalize("/usr/./bin/../lib"), "/usr/lib");
        assert_eq!(normalize("/.."), "/");
        assert_eq!(normalize("/a/b/../../.."), "/");
        assert_eq!(normalize("a/../b"), "b");
        assert_eq!(normalize(".."), "..");
        assert_eq!(normalize("/"), "/");
    }

    #[test]
    fn arch_facts_are_consistent() {
        assert_eq!(Arch::Aarch64.loader_name(), "ld-linux-aarch64.so.1");
        assert_eq!(Arch::X86_64.loader_name(), "ld-linux-x86-64.so.2");
        assert_eq!(
            Arch::from_machine(crate::analyzer::elf::EM_AARCH64),
            Some(Arch::Aarch64)
        );
        assert_eq!(
            Arch::from_machine(crate::analyzer::elf::EM_X86_64),
            Some(Arch::X86_64)
        );
        assert_eq!(Arch::from_machine(0x03), None);
    }

    #[test]
    fn guest_path_matches_debian() {
        for dir in ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] {
            assert!(
                split_path_list(GUEST_PATH_DEFAULT).contains(&dir.to_string()),
                "missing {dir}"
            );
        }
    }
}
