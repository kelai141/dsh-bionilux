use std::env;
use std::fmt;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::analyzer::elf::{self, Libc};
use crate::debug;
use crate::launcher::config::{Arch, Config, config, join_guest, normalize, split_path_list};
use crate::launcher::rootfs::Rootfs;

const MAX_SHEBANG_DEPTH: u32 = 4;

/// Sub-directory of a rootfs that may hold a preload built against that
/// rootfs' own glibc. Kept short and stable: the guest must not care.
const ROOTFS_PRELOAD_DIR: &str = "/usr/lib/bionilux";

/// A resolved execution plan.
pub struct Execution {
    /// Path handed to `execve()`, already mapped out of the guest.
    pub exec_target: PathBuf,
    /// Physical path of the user's target, used to derive the guest cwd.
    pub original_target: PathBuf,
    /// argv[0..] as the guest should observe it.
    pub argv: Vec<String>,
    /// glibc loader, or `None` for native execution.
    pub loader: Option<PathBuf>,
    pub preload: Option<PathBuf>,
    /// Architecture of the *target*, not of the host.
    pub arch: Arch,
    /// `VAR=VALUE` entries from an `env` shebang, applied to the guest env.
    pub env_overrides: Vec<(String, String)>,
}

impl Execution {
    pub fn is_native(&self) -> bool {
        self.loader.is_none()
    }
}

#[derive(Debug)]
pub enum Error {
    NotFound(String),
    NoPreload,
    NoBox64,
    NoLoader(String),
    Unsupported(String),
}

impl Error {
    pub fn exit_code(&self) -> i32 {
        match self {
            Error::NotFound(_) => 127,
            _ => 1,
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            Error::NotFound(n) => write!(f, "command not found: {n}"),
            Error::NoPreload => write!(
                f,
                "libbionilux_preload.so not found; set BIONILUX_PRELOAD or install it next to the launcher"
            ),
            Error::NoBox64 => {
                let hint = config()
                    .box64
                    .as_ref()
                    .map(|p| p.display().to_string())
                    .unwrap_or_else(|| "BIONILUX_BOX64".into());
                write!(f, "box64 not found at {hint}")
            }
            Error::NoLoader(i) => write!(f, "loader {i} not found"),
            Error::Unsupported(m) => write!(f, "unsupported: {m}"),
        }
    }
}

/// Resolve `raw` plus its arguments into an execution plan.
///
/// `guest_cwd` is the guest's logical working directory; relative targets and
/// bare names are resolved against it.
pub fn resolve(raw: &str, args: &[String], guest_cwd: &str) -> Result<Execution, Error> {
    resolve_at(raw, args, guest_cwd, 0)
}

fn resolve_at(raw: &str, args: &[String], guest_cwd: &str, depth: u32) -> Result<Execution, Error> {
    let cfg = config();
    let target = resolve_target(raw, guest_cwd).ok_or_else(|| Error::NotFound(raw.into()))?;
    debug!("resolved: {}", target.display());

    let Some(info) = elf::analyze(&target) else {
        return script(&target, args, guest_cwd, depth);
    };

    if matches!(info.libc, Libc::Musl | Libc::Other) {
        return Err(Error::Unsupported(format!("libc {:?}", info.libc)));
    }

    let Some(arch) = Arch::from_machine(info.machine) else {
        return Err(Error::Unsupported(format!("machine 0x{:x}", info.machine)));
    };

    if matches!(info.libc, Libc::Bionic | Libc::Static) {
        // A host-native binary runs as-is. A static binary for another
        // architecture has no interpreter to redirect and no emulator.
        if arch != Arch::host() {
            return Err(Error::Unsupported(format!(
                "static/foreign {arch:?} binary cannot run on a {:?} host",
                Arch::host()
            )));
        }
        debug!("native");
        return Ok(Execution {
            exec_target: target.clone(),
            original_target: target,
            argv: args.to_vec(),
            loader: None,
            preload: None,
            arch,
            env_overrides: Vec::new(),
        });
    }

    // A glibc ELF needs its loader; a foreign architecture also needs an
    // emulator in front of it. box64 only works one way (x86_64 on aarch64).
    let (exec_target, argv) = if arch == Arch::host() {
        debug!("{arch:?} glibc -> native loader");
        (target.clone(), args.to_vec())
    } else {
        let Some(box64) = cfg.box64.clone().filter(|p| p.exists()) else {
            return Err(Error::NoBox64);
        };
        if Arch::host() != Arch::Aarch64 {
            return Err(Error::Unsupported(format!(
                "no emulator for {arch:?} targets on a {:?} host",
                Arch::host()
            )));
        }
        debug!("{arch:?} glibc on {:?} host -> box64", Arch::host());
        // argv[0] must be box64's full path — box64 uses it to find itself.
        let mut v = vec![
            box64.to_string_lossy().into_owned(),
            target.display().to_string(),
        ];
        v.extend(args.iter().skip(1).cloned());
        (box64, v)
    };

    let interp = info
        .interpreter
        .clone()
        .unwrap_or_else(|| format!("/lib/{}", arch.loader_name()));
    let loader = find_loader(&interp, arch).ok_or(Error::NoLoader(interp))?;
    let preload = find_preload().ok_or(Error::NoPreload)?;

    Ok(Execution {
        exec_target,
        original_target: target,
        argv,
        loader: Some(loader),
        preload: Some(preload),
        arch,
        env_overrides: Vec::new(),
    })
}

/// Map a user-supplied target to a physical path.
///
/// A name containing `/` is treated as a path, anything else as a `PATH`
/// lookup — the same rule `execvp` uses.
pub fn resolve_target(raw: &str, guest_cwd: &str) -> Option<PathBuf> {
    let cfg = config();
    let rootfs = Rootfs::current();

    if raw.contains('/') {
        let logical = if raw.starts_with('/') {
            normalize(raw)
        } else {
            normalize(&join_guest(guest_cwd, raw))
        };
        if rootfs.enabled() {
            return rootfs.map_existing(&logical).map(PathBuf::from);
        }
        let legacy = rewrite_legacy_prefix(&logical);
        let p = PathBuf::from(&legacy);
        // An explicit path that exists is handed to execve, which reports the
        // real error (EACCES, ENOEXEC) instead of a misleading "not found".
        return p.exists().then_some(p);
    }

    if rootfs.enabled() {
        return rootfs.search(raw, guest_cwd, &cfg.guest_path);
    }
    host_search(raw)
}

/// Search the launcher's own `PATH`. Only used when no rootfs is configured,
/// where the host user space *is* the guest.
fn host_search(name: &str) -> Option<PathBuf> {
    let path = env::var("PATH").unwrap_or_default();
    for dir in split_path_list(&path) {
        let candidate = PathBuf::from(&dir).join(name);
        if crate::launcher::rootfs::is_executable(&candidate) {
            return Some(candidate);
        }
    }
    None
}

/// Termux has neither `/bin` nor `/usr/bin`; its user space lives under
/// `$PREFIX`. Applied only when no rootfs is configured, so a Debian guest
/// keeps its real `/bin`.
fn rewrite_legacy_prefix(path: &str) -> String {
    let Some(prefix) = config().prefix.as_ref() else {
        return path.to_string();
    };
    for dir in ["/bin/", "/usr/bin/"] {
        if let Some(rest) = path.strip_prefix(dir) {
            return prefix.join("bin").join(rest).to_string_lossy().into_owned();
        }
    }
    path.to_string()
}

/// Locate the glibc loader for `interp` (a guest-visible path such as
/// `/lib/ld-linux-aarch64.so.1`).
///
/// With a rootfs configured the loader must come from inside it: mixing a
/// host loader with guest libraries produces a hybrid that matches neither
/// side's expectations.
pub fn find_loader(interp: &str, arch: Arch) -> Option<PathBuf> {
    let cfg = config();
    let rootfs = Rootfs::current();

    if let Some(explicit) = &cfg.loader
        && explicit.exists()
    {
        return Some(explicit.clone());
    }

    let name = Path::new(interp)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| arch.loader_name().to_string());

    if rootfs.enabled() {
        let mut candidates = vec![interp.to_string()];
        for dir in ["/lib", "/usr/lib", "/lib64"] {
            candidates.push(format!("{dir}/{name}"));
        }
        for candidate in candidates {
            if let Some(physical) = rootfs.map_existing(&candidate) {
                return Some(PathBuf::from(physical));
            }
        }
        return None;
    }

    if Path::new(interp).exists() {
        return Some(PathBuf::from(interp));
    }
    let alt = cfg.runtime_dir.as_ref()?.join("lib").join(&name);
    alt.exists().then_some(alt)
}

/// Locate the preload hook library.
///
/// Order matters: a library built against the rootfs' glibc must win over one
/// built against the host's, because the guest loader resolves its versioned
/// symbols against the guest libc.
fn find_preload() -> Option<PathBuf> {
    let cfg = config();
    let rootfs = Rootfs::current();

    if let Some(p) = &cfg.preload
        && p.exists()
    {
        return Some(p.clone());
    }

    for candidate in [ROOTFS_PRELOAD_DIR, "/usr/lib", "/usr/local/lib"] {
        let logical = format!("{candidate}/libbionilux_preload.so");
        if let Some(physical) = rootfs.map_existing(&logical) {
            return Some(PathBuf::from(physical));
        }
    }

    // Development layout: target/<profile>/bionilux -> project root.
    if let Ok(exe) = env::current_exe() {
        let mut dir = exe.parent();
        for _ in 0..3 {
            let Some(d) = dir else { break };
            let p = d.join("libbionilux_preload.so");
            if p.exists() {
                return Some(p);
            }
            dir = d.parent();
        }
    }

    if let Some(rt) = &cfg.runtime_dir {
        let p = rt.join("lib/libbionilux_preload.so");
        if p.exists() {
            return Some(p);
        }
    }
    None
}

/// Shebang script: resolve the interpreter, then rebuild argv.
fn script(script: &Path, args: &[String], guest_cwd: &str, depth: u32) -> Result<Execution, Error> {
    if depth >= MAX_SHEBANG_DEPTH {
        return Err(Error::Unsupported("shebang recursion too deep".into()));
    }

    let (interp, interp_arg) =
        parse_shebang(script).ok_or_else(|| Error::Unsupported("not ELF or shebang".into()))?;

    // `#!/usr/bin/env prog` — resolve prog directly rather than running env,
    // because env would re-resolve it and, without a rootfs, the host's
    // native `env` would escape the rerouting.
    let (interp, interp_args, overrides) = if Path::new(&interp).file_name() == Some("env".as_ref())
    {
        let arg =
            interp_arg.ok_or_else(|| Error::Unsupported("env shebang without program".into()))?;
        let mut words: Vec<String> = arg.split_whitespace().map(String::from).collect();
        if words.first().map(String::as_str) == Some("-S") {
            words.remove(0);
        }
        // `env VAR=VALUE prog` assigns before running the program.
        let mut overrides = Vec::new();
        while words[0].contains('=') && !words[0].starts_with('-') {
            let w = words.remove(0);
            let (k, v) = w.split_once('=').expect("checked for '='");
            overrides.push((k.to_string(), v.to_string()));
            if words.is_empty() {
                break;
            }
        }
        if words.is_empty() {
            return Err(Error::Unsupported("env shebang without program".into()));
        }
        let prog = words.remove(0);
        let rest = if words.is_empty() { None } else { Some(words) };
        (prog, rest, overrides)
    } else {
        (interp, interp_arg.map(|a| vec![a]), Vec::new())
    };

    let interp_path = resolve_target(&interp, guest_cwd)
        .ok_or_else(|| Error::Unsupported(format!("shebang interp not found: {interp}")))?;

    let interp_str = interp_path
        .to_str()
        .ok_or_else(|| Error::Unsupported("non-UTF-8 interpreter path".into()))?;
    let inner = resolve_at(
        interp_str,
        std::slice::from_ref(&interp),
        guest_cwd,
        depth + 1,
    )?;

    // Start from inner.argv — preserves [BOX64, interp] for emulated targets.
    let mut argv = inner.argv.clone();
    if let Some(extra) = interp_args {
        argv.extend(extra);
    }
    argv.push(script.display().to_string());
    argv.extend(args.iter().skip(1).cloned());

    Ok(Execution {
        exec_target: inner.exec_target,
        original_target: script.to_path_buf(),
        argv,
        loader: inner.loader,
        preload: inner.preload,
        arch: inner.arch,
        env_overrides: {
            let mut o = inner.env_overrides;
            o.extend(overrides);
            o
        },
    })
}

fn parse_shebang(path: &Path) -> Option<(String, Option<String>)> {
    let mut f = File::open(path).ok()?;
    let mut buf = [0u8; 256];
    let n = f.read(&mut buf).ok()?;
    if n < 3 || &buf[..2] != b"#!" {
        return None;
    }
    // Stop at the first newline so non-UTF-8 bytes later in the file don't fail.
    let end = buf[2..n]
        .iter()
        .position(|&b| b == b'\n')
        .map_or(n, |i| i + 2);
    let line = std::str::from_utf8(&buf[2..end]).ok()?.trim();
    let mut parts = line.splitn(2, char::is_whitespace);
    let interp = parts.next()?.to_string();
    let arg = parts
        .next()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);
    Some((interp, arg))
}

/// Guest working directory for a launch.
///
/// When the host cwd already sits inside the rootfs the guest keeps it — that
/// is how a child inherits its parent's directory without a `chdir`.
pub fn guest_cwd_for(cfg: &Config, rootfs: &Rootfs, pwd: &Path) -> String {
    if rootfs.enabled() && rootfs.contains(pwd) {
        return rootfs.unmap(&pwd.to_string_lossy());
    }
    cfg.guest_cwd.clone()
}

/// Physical directories the loader must be told about.
///
/// A Debian loader has the guest's `/lib/<triplet>` compiled into its default
/// search path. Those are guest paths, so on Android they resolve against the
/// host and find nothing. The physical equivalents are handed to the loader
/// explicitly. Without a rootfs the host's own paths still work, so nothing is
/// added.
pub fn library_path(cfg: &Config, arch: Arch) -> Vec<String> {
    let Some(root) = cfg.rootfs.as_ref() else {
        return Vec::new();
    };
    let mut dirs: Vec<String> = Vec::new();
    let mut push = |dir: &str| {
        let physical = root.join(dir.trim_start_matches('/'));
        if physical.is_dir() {
            let s = physical.to_string_lossy().into_owned();
            if !dirs.contains(&s) {
                dirs.push(s);
            }
        }
    };
    for dir in arch.lib_dirs() {
        push(dir);
    }
    // Debian puts the loader in /lib on aarch64 and in /lib64 on x86_64.
    push("/lib");
    push("/usr/lib");
    // Last resort: the rootfs root itself, for unusual layouts.
    let root_s = root.to_string_lossy().into_owned();
    if !dirs.contains(&root_s) {
        dirs.push(root_s);
    }
    dirs
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    fn write_temp(content: &[u8]) -> NamedTempFile {
        let mut f = NamedTempFile::new().unwrap();
        f.write_all(content).unwrap();
        f.flush().unwrap();
        f
    }

    // ── parse_shebang ───────────────────────────────────────────────

    #[test]
    fn shebang_with_arg() {
        let f = write_temp(b"#!/usr/bin/env python3\nprint('x')\n");
        let (interp, arg) = parse_shebang(f.path()).unwrap();
        assert_eq!(interp, "/usr/bin/env");
        assert_eq!(arg.as_deref(), Some("python3"));
    }

    #[test]
    fn shebang_without_arg() {
        let f = write_temp(b"#!/bin/sh\necho hi\n");
        let (interp, arg) = parse_shebang(f.path()).unwrap();
        assert_eq!(interp, "/bin/sh");
        assert!(arg.is_none());
    }

    #[test]
    fn shebang_strips_trailing_whitespace() {
        let f = write_temp(b"#!/bin/sh   \n");
        let (interp, arg) = parse_shebang(f.path()).unwrap();
        assert_eq!(interp, "/bin/sh");
        assert!(arg.is_none());
    }

    #[test]
    fn no_shebang_returns_none() {
        let f = write_temp(b"just some text\n");
        assert!(parse_shebang(f.path()).is_none());
    }

    #[test]
    fn empty_file_returns_none() {
        let f = write_temp(b"");
        assert!(parse_shebang(f.path()).is_none());
    }

    #[test]
    fn shebang_only_hashbang() {
        let f = write_temp(b"#!");
        assert!(parse_shebang(f.path()).is_none());
    }

    #[test]
    fn shebang_with_non_utf8_after_first_line() {
        let f = write_temp(b"#!/bin/sh\necho \xff\xfe\n");
        let (interp, arg) = parse_shebang(f.path()).unwrap();
        assert_eq!(interp, "/bin/sh");
        assert!(arg.is_none());
    }

    // ── resolve_target ──────────────────────────────────────────────
    //
    // With BIONILUX_ROOTFS unset (the default in this test process) the
    // launcher behaves like upstream: the host user space is the guest.

    #[test]
    fn relative_path_target_is_resolved_against_guest_cwd() {
        let f = write_temp(b"#!/bin/sh\n");
        let dir = f.path().parent().unwrap();
        let name = f.path().file_name().unwrap().to_string_lossy().into_owned();
        let found = resolve_target(&format!("./{name}"), &dir.to_string_lossy());
        assert_eq!(found.unwrap(), f.path());
    }

    #[test]
    fn missing_absolute_path_is_not_found() {
        assert!(resolve_target("/nonexistent/definitely/not/here", "/").is_none());
    }

    #[test]
    fn bare_name_uses_host_path_when_no_rootfs_is_configured() {
        // `sh` exists on any POSIX host and must be found through PATH.
        assert!(resolve_target("sh", "/").is_some());
        assert!(resolve_target("bionilux-no-such-program", "/").is_none());
    }

    #[test]
    fn legacy_prefix_rewrite_only_touches_bin_dirs() {
        assert_eq!(rewrite_legacy_prefix("/opt/foo/bar"), "/opt/foo/bar");
        assert_eq!(rewrite_legacy_prefix("sh"), "sh");
        assert_eq!(
            rewrite_legacy_prefix("/usr/local/bin/x"),
            "/usr/local/bin/x"
        );
    }

    // ── find_loader ─────────────────────────────────────────────────

    #[test]
    fn find_loader_missing_outside_any_rootfs() {
        assert!(find_loader("/nonexistent/foo/ld-fake.so", Arch::Aarch64).is_none());
    }
}
