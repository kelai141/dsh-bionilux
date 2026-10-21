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
    /// Architecture of the executable the kernel and its loader will run.
    pub execution_arch: Arch,
    /// `VAR=VALUE` entries from an `env` shebang, applied to the guest env.
    pub env_overrides: Vec<(String, String)>,
    /// ELF the loader will treat as the main object. Its directory is what
    /// $ORIGIN means to the guest.
    pub main_elf: Option<PathBuf>,
    /// DT_RPATH entries of main_elf, as the guest wrote them.
    pub rpath: Vec<String>,
    /// DT_RUNPATH entries of main_elf, as the guest wrote them.
    pub runpath: Vec<String>,
}

impl Execution {
    /// True when no glibc runtime is involved: no loader and no hook.
    ///
    /// A program started by executing the rootfs loader itself has no loader
    /// field but keeps its preload, because it is still a guest process.
    pub fn is_native(&self) -> bool {
        self.loader.is_none() && self.preload.is_none()
    }
}

#[derive(Debug)]
pub enum Error {
    NotFound(String),
    PermissionDenied(String),
    NoPreload,
    NoBox64,
    NoLoader(String),
    Unsupported(String),
}

impl Error {
    pub fn exit_code(&self) -> i32 {
        match self {
            Error::NotFound(_) => 127,
            Error::PermissionDenied(_) => 126,
            _ => 1,
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            Error::NotFound(n) => write!(f, "command not found: {n}"),
            Error::PermissionDenied(n) => write!(f, "permission denied: {n}"),
            Error::NoPreload => write!(
                f,
                "libbionilux_preload.so not found; set BIONILUX_PRELOAD or install it next to the launcher"
            ),
            Error::NoBox64 => write!(
                f,
                "box64 not found; set BIONILUX_BOX64 to a host glibc executable"
            ),
            Error::NoLoader(i) => write!(f, "loader {i} not found"),
            Error::Unsupported(m) => write!(f, "unsupported: {m}"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ArchitecturePlan {
    target: Arch,
    execution: Arch,
}

fn architecture_plan(
    target: Arch,
    target_libc: Libc,
    host: Arch,
    box64: Option<&elf::ElfInfo>,
) -> Result<ArchitecturePlan, Error> {
    if target != host {
        if target != Arch::X86_64 || host != Arch::Aarch64 || target_libc != Libc::Glibc {
            return Err(Error::Unsupported(format!(
                "cross-architecture {target:?} {target_libc:?} targets on {host:?}"
            )));
        }
        let box64 = box64.ok_or(Error::NoBox64)?;
        if Arch::from_machine(box64.machine) != Some(host) || box64.libc != Libc::Glibc {
            return Err(Error::Unsupported(format!(
                "box64 must be a {host:?} glibc ELF executable"
            )));
        }
    }
    Ok(ArchitecturePlan {
        target,
        execution: host,
    })
}

fn execution_argv(target: &Path, args: &[String], box64: Option<&Path>) -> Vec<String> {
    let Some(box64) = box64 else {
        return args.to_vec();
    };
    let mut argv = vec![
        box64.to_string_lossy().into_owned(),
        target.to_string_lossy().into_owned(),
    ];
    argv.extend(args.iter().skip(1).cloned());
    argv
}

/// Resolve `raw` plus its arguments into an execution plan.
///
/// `guest_cwd` is the guest's logical working directory; relative targets and
/// bare names are resolved against it.
pub fn resolve(
    raw: &str,
    args: &[String],
    guest_cwd: &str,
    inject_preload: bool,
) -> Result<Execution, Error> {
    resolve_at(raw, args, guest_cwd, 0, inject_preload)
}

fn resolve_at(
    raw: &str,
    args: &[String],
    guest_cwd: &str,
    depth: u32,
    inject_preload: bool,
) -> Result<Execution, Error> {
    let target = resolve_target(raw, guest_cwd).ok_or_else(|| Error::NotFound(raw.into()))?;
    debug!("resolved: {}", target.display());
    if !crate::launcher::rootfs::is_executable(&target) {
        return Err(Error::PermissionDenied(raw.into()));
    }

    let Some(info) = elf::analyze(&target) else {
        return script(&target, args, guest_cwd, depth, inject_preload);
    };

    if matches!(info.libc, Libc::Musl | Libc::Other) {
        return Err(Error::Unsupported(format!("libc {:?}", info.libc)));
    }

    let Some(arch) = Arch::from_machine(info.machine) else {
        return Err(Error::Unsupported(format!("machine 0x{:x}", info.machine)));
    };

    let cfg = config();
    let host = Arch::host();

    // A glibc loader has no PT_INTERP of its own, so it looks like a static
    // binary. Running it is still meaningful: it can inspect and load a guest
    // program (ld.so --list, --verify, or a bare program name). Treat it as
    // such only when it really is the rootfs' loader.
    if info.dynamic && info.interpreter.is_none() && is_guest_loader(cfg, &target, arch) {
        if arch != host {
            return Err(Error::Unsupported(format!(
                "cross-architecture {arch:?} loader invocation on {host:?}"
            )));
        }
        debug!("guest loader invocation");
        return direct_loader(&target, args, guest_cwd, arch, inject_preload);
    }

    let box64 = if arch == Arch::X86_64 && host == Arch::Aarch64 && info.libc == Libc::Glibc {
        let path = cfg
            .box64
            .as_ref()
            .filter(|p| p.exists())
            .ok_or(Error::NoBox64)?;
        if !crate::launcher::rootfs::is_executable(path) {
            return Err(Error::PermissionDenied(path.display().to_string()));
        }
        let info = elf::analyze(path)
            .ok_or_else(|| Error::Unsupported("box64 is not an ELF executable".into()))?;
        Some((path.clone(), info))
    } else {
        None
    };
    let architecture =
        architecture_plan(arch, info.libc, host, box64.as_ref().map(|(_, info)| info))?;

    if matches!(info.libc, Libc::Bionic | Libc::Static) {
        debug!("native");
        return Ok(Execution {
            exec_target: target.clone(),
            original_target: target,
            argv: args.to_vec(),
            loader: None,
            preload: None,
            arch: architecture.target,
            execution_arch: architecture.execution,
            env_overrides: Vec::new(),
            main_elf: None,
            rpath: Vec::new(),
            runpath: Vec::new(),
        });
    }

    let (exec_target, interp) = if let Some((path, box64_info)) = &box64 {
        debug!(
            "{arch:?} glibc -> {:?} box64 loader",
            architecture.execution
        );
        (
            path.clone(),
            box64_info
                .interpreter
                .clone()
                .unwrap_or_else(|| format!("/lib/{}", architecture.execution.loader_name())),
        )
    } else {
        debug!("{arch:?} glibc -> native loader");
        (
            target.clone(),
            info.interpreter
                .clone()
                .unwrap_or_else(|| format!("/lib/{}", architecture.execution.loader_name())),
        )
    };
    // Keep Box64's own full path as argv[0], as in the pre-PR execution chain.
    let argv = execution_argv(
        &target,
        args,
        box64.as_ref().map(|(path, _)| path.as_path()),
    );
    let loader = if box64.is_some() {
        find_host_loader(cfg, &interp, architecture.execution)
    } else {
        find_loader(&interp, architecture.execution)
    }
    .ok_or(Error::NoLoader(interp))?;
    let preload = if inject_preload {
        Some(find_preload(architecture.execution).ok_or(Error::NoPreload)?)
    } else {
        None
    };

    Ok(Execution {
        exec_target,
        main_elf: Some(target.clone()),
        original_target: target,
        argv,
        loader: Some(loader),
        preload,
        arch: architecture.target,
        execution_arch: architecture.execution,
        env_overrides: Vec::new(),
        rpath: info.rpath.clone(),
        runpath: info.runpath.clone(),
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
    host_search(raw, guest_cwd)
}

/// Search the launcher's own `PATH`. Only used when no rootfs is configured,
/// where the host user space *is* the guest.
fn host_search(name: &str, guest_cwd: &str) -> Option<PathBuf> {
    let path = env::var("PATH").unwrap_or_default();
    Rootfs::current().search(name, guest_cwd, &split_path_list(&path))
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

fn find_host_loader(cfg: &Config, interp: &str, arch: Arch) -> Option<PathBuf> {
    if let Some(path) = &cfg.loader
        && path.exists()
    {
        return Some(path.clone());
    }
    if Path::new(interp).exists() {
        return Some(PathBuf::from(interp));
    }
    let name = Path::new(interp)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| arch.loader_name().to_string());
    if let Some(runtime) = &cfg.runtime_dir {
        let candidate = runtime.join("lib").join(&name);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    let rootfs = Rootfs::from_config(cfg);
    for dir in ["/lib", "/usr/lib", "/lib64"] {
        if let Some(path) = rootfs.map_existing(&format!("{dir}/{name}")) {
            return Some(PathBuf::from(path));
        }
    }
    None
}

fn matches_arch(path: &Path, arch: Arch) -> bool {
    elf::analyze(path).is_some_and(|info| Arch::from_machine(info.machine) == Some(arch))
}

/// Locate the preload hook library.
///
/// Order matters: a library built against the rootfs' glibc must win over one
/// built against the host's, because the guest loader resolves its versioned
/// symbols against the guest libc.
fn find_preload(arch: Arch) -> Option<PathBuf> {
    let cfg = config();
    let rootfs = Rootfs::current();

    if let Some(p) = &cfg.preload
        && matches_arch(p, arch)
    {
        return Some(p.clone());
    }

    for candidate in [ROOTFS_PRELOAD_DIR, "/usr/lib", "/usr/local/lib"] {
        let logical = format!("{candidate}/libbionilux_preload.so");
        if let Some(physical) = rootfs.map_existing(&logical) {
            let physical = PathBuf::from(physical);
            if matches_arch(&physical, arch) {
                return Some(physical);
            }
        }
    }

    // Development layout: target/<profile>/bionilux -> project root.
    if let Ok(exe) = env::current_exe() {
        let mut dir = exe.parent();
        for _ in 0..3 {
            let Some(d) = dir else { break };
            let p = d.join("libbionilux_preload.so");
            if matches_arch(&p, arch) {
                return Some(p);
            }
            dir = d.parent();
        }
    }

    if let Some(rt) = &cfg.runtime_dir {
        let p = rt.join("lib/libbionilux_preload.so");
        if matches_arch(&p, arch) {
            return Some(p);
        }
    }
    None
}

/// Shebang script: resolve the interpreter, then rebuild argv.
fn script(
    script: &Path,
    args: &[String],
    guest_cwd: &str,
    depth: u32,
    inject_preload: bool,
) -> Result<Execution, Error> {
    if depth >= MAX_SHEBANG_DEPTH {
        return Err(Error::Unsupported("shebang recursion too deep".into()));
    }

    let (interp, interp_arg) =
        parse_shebang(script).ok_or_else(|| Error::Unsupported("not ELF or shebang".into()))?;

    let (interp, interp_args, overrides) =
        shebang_command(interp, interp_arg, Rootfs::current().enabled())?;

    let interp_path = if !interp.contains('/')
        && let Some((_, path)) = overrides.iter().rev().find(|(key, _)| key == "PATH")
    {
        Rootfs::current().search(&interp, guest_cwd, &split_path_list(path))
    } else {
        resolve_target(&interp, guest_cwd)
    }
    .ok_or_else(|| Error::Unsupported(format!("shebang interp not found: {interp}")))?;

    let interp_str = interp_path
        .to_str()
        .ok_or_else(|| Error::Unsupported("non-UTF-8 interpreter path".into()))?;
    let inner = resolve_at(
        interp_str,
        std::slice::from_ref(&interp),
        guest_cwd,
        depth + 1,
        inject_preload,
    )?;

    // The interpreter owns argv[0]; a script's custom argv[0] is discarded.
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
        execution_arch: inner.execution_arch,
        main_elf: inner.main_elf,
        rpath: inner.rpath,
        runpath: inner.runpath,
        env_overrides: {
            let mut o = overrides;
            o.extend(inner.env_overrides);
            o
        },
    })
}

type ShebangCommand = (String, Option<Vec<String>>, Vec<(String, String)>);

fn shebang_command(
    interp: String,
    interp_arg: Option<String>,
    rootfs_enabled: bool,
) -> Result<ShebangCommand, Error> {
    if Path::new(&interp).file_name() != Some("env".as_ref()) {
        return Ok((interp, interp_arg.map(|arg| vec![arg]), Vec::new()));
    }
    let arg = interp_arg.ok_or_else(|| Error::Unsupported("env shebang without program".into()))?;
    if arg.trim() == "-S" || arg.trim() == "--split-string=" {
        return Err(Error::Unsupported("env shebang without program".into()));
    }
    if rootfs_enabled {
        // GNU env owns -S quoting, escapes, expansion, assignments and options.
        // Keep the kernel's single optional shebang argument intact.
        return Ok((interp, Some(vec![arg]), Vec::new()));
    }

    // A Bionic env cannot reroute glibc children in legacy (no-rootfs) mode.
    let mut words = if let Some(value) = arg.strip_prefix("-S") {
        split_legacy_env_words(value)?
    } else if let Some(value) = arg.strip_prefix("--split-string=") {
        split_legacy_env_words(value)?
    } else {
        vec![arg]
    };
    let mut overrides = Vec::new();
    while words
        .first()
        .is_some_and(|word| word.contains('=') && !word.starts_with('-'))
    {
        let word = words.remove(0);
        let (key, value) = word.split_once('=').expect("checked for '='");
        overrides.push((key.to_string(), value.to_string()));
    }
    if words.is_empty() || words[0].is_empty() || words[0].starts_with('-') {
        return Err(Error::Unsupported(
            "env shebang without supported program".into(),
        ));
    }
    let program = words.remove(0);
    Ok((program, Some(words), overrides))
}

fn split_legacy_env_words(value: &str) -> Result<Vec<String>, Error> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quote = None;
    let mut escaped = false;
    let mut started = false;
    for ch in value.chars() {
        if escaped {
            word.push(ch);
            escaped = false;
        } else if ch == '\\' && quote != Some('\'') {
            escaped = true;
            started = true;
        } else if quote == Some(ch) {
            quote = None;
        } else if quote.is_some() {
            word.push(ch);
        } else if ch == '\'' || ch == '"' {
            quote = Some(ch);
            started = true;
        } else if ch.is_whitespace() {
            if started {
                words.push(std::mem::take(&mut word));
                started = false;
            }
        } else {
            word.push(ch);
            started = true;
        }
    }
    if escaped || quote.is_some() {
        return Err(Error::Unsupported(
            "unterminated env shebang quoting".into(),
        ));
    }
    if started {
        words.push(word);
    }
    Ok(words)
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

/// True when path is the rootfs' own glibc loader.
///
/// The name check alone is not enough: a static binary can be called anything.
/// Requiring the file name, a dynamic segment (checked by the caller) and a
/// location inside the configured rootfs keeps ordinary static executables on
/// the normal path.
fn is_guest_loader(cfg: &Config, path: &Path, arch: Arch) -> bool {
    if path.file_name().and_then(|name| name.to_str()) != Some(arch.loader_name()) {
        return false;
    }
    if cfg.loader.as_deref() == Some(path) {
        return true;
    }
    cfg.rootfs
        .as_ref()
        .is_some_and(|root| path.starts_with(root))
}

/// Loader options whose following argument belongs to the loader rather than
/// to the guest program.
const LOADER_VALUE_OPTIONS: &[&str] = &[
    "--library-path",
    "--preload",
    "--audit",
    "--argv0",
    "--inhibit-rpath",
    "--glibc-hwcaps-prepend",
    "--glibc-hwcaps-mask",
];

/// Run the rootfs loader itself with a translated guest program.
///
/// Only the pieces that cannot work otherwise are touched: the program name is
/// mapped into the rootfs, and the loader receives a physical --library-path.
/// Everything after the program name is passed through untouched, and so are
/// options this code does not understand. Other options that name guest paths
/// (--preload, --audit) are left as written.
fn direct_loader(
    loader: &Path,
    args: &[String],
    guest_cwd: &str,
    arch: Arch,
    inject_preload: bool,
) -> Result<Execution, Error> {
    let cfg = config();
    let rootfs = Rootfs::current();
    let mut argv: Vec<String> = vec![
        args.first()
            .cloned()
            .unwrap_or_else(|| loader.display().to_string()),
    ];
    let mut program: Option<PathBuf> = None;
    let mut program_slot = 0;
    let mut library_slot: Option<usize> = None;
    let mut library_value: Option<String> = None;
    let mut diagnostic = false;
    let mut index = 1;
    while index < args.len() {
        let arg = &args[index];
        if program.is_some() {
            // Arguments of the guest program are not the loader's business.
            argv.push(arg.clone());
            index += 1;
            continue;
        }
        if let Some(option) = arg.strip_prefix("--") {
            let (name, inline_value) = match option.split_once('=') {
                Some((name, value)) => (format!("--{name}"), Some(value)),
                None => (arg.clone(), None),
            };
            let has_inline_value = inline_value.is_some();
            if matches!(
                arg.as_str(),
                "--list"
                    | "--verify"
                    | "--help"
                    | "--version"
                    | "--list-tunables"
                    | "--list-diagnostics"
            ) {
                // These options inspect the loader's inputs and exit without
                // starting the program.
                diagnostic = true;
                argv.push(arg.clone());
                index += 1;
                continue;
            }
            if LOADER_VALUE_OPTIONS.contains(&name.as_str()) {
                let value = match inline_value {
                    Some(value) => {
                        index += 1;
                        value.to_string()
                    }
                    None => {
                        let value = args.get(index + 1).ok_or_else(|| {
                            Error::Unsupported(format!("{name} needs an argument"))
                        })?;
                        index += 2;
                        value.clone()
                    }
                };
                if name == "--library-path" {
                    // A guest path list would be read as host paths. It is
                    // translated once the program (and therefore $ORIGIN) is
                    // known, then inserted at the same position.
                    if library_slot.is_none() {
                        library_slot = Some(argv.len());
                    }
                    library_value = Some(value);
                } else if has_inline_value {
                    argv.push(arg.clone());
                } else {
                    argv.push(arg.clone());
                    argv.push(value);
                }
                continue;
            }
            // --inhibit-cache or an option this code does not know: keep it
            // verbatim rather than guessing what it means.
            argv.push(arg.clone());
            index += 1;
            continue;
        }
        // First non-option argument: the guest program the loader acts on.
        let physical =
            resolve_target(arg, guest_cwd).ok_or_else(|| Error::NotFound(arg.clone()))?;
        program_slot = argv.len();
        argv.push(physical.to_string_lossy().into_owned());
        program = Some(physical);
        index += 1;
    }

    let mut rpath = Vec::new();
    let mut runpath = Vec::new();
    if let Some(path) = &program {
        if let Some(info) = elf::analyze(path) {
            rpath = info.rpath;
            runpath = info.runpath;
        }
        let inherited = library_value
            .clone()
            .or_else(|| env::var("LD_LIBRARY_PATH").ok());
        let dirs = loader_search_path(
            cfg,
            rootfs,
            &LoaderSearch {
                target: arch,
                execution: arch,
                main_elf: path,
                rpath: &rpath,
                runpath: &runpath,
                guest_library_path: inherited.as_deref(),
                guest_cwd,
            },
        );
        if !dirs.is_empty() {
            let slot = library_slot.unwrap_or(program_slot);
            argv.insert(slot, dirs.join(":"));
            argv.insert(slot, "--library-path".into());
        }
    } else if let Some(value) = library_value {
        // Nothing to translate the path against; keep the invocation as the
        // guest wrote it.
        let slot = library_slot.unwrap_or(argv.len());
        argv.insert(slot, value);
        argv.insert(slot, "--library-path".into());
    }

    // Running a program through the loader is still a guest process: without
    // the hook it would see host paths. Diagnostics never start the program,
    // so they stay usable even when the hook is not installed.
    let preload = if inject_preload && program.is_some() && !diagnostic {
        Some(find_preload(arch).ok_or(Error::NoPreload)?)
    } else {
        None
    };

    Ok(Execution {
        exec_target: loader.to_path_buf(),
        original_target: program.clone().unwrap_or_else(|| loader.to_path_buf()),
        argv,
        loader: None,
        preload,
        arch,
        execution_arch: arch,
        env_overrides: Vec::new(),
        main_elf: program,
        rpath,
        runpath,
    })
}

/// Guest working directory for a launch.
///
/// The host cwd is kept whenever the guest can already see it under the same
/// name: inside the rootfs it becomes the matching guest path, and under an
/// authorized host directory (--host-path, the install prefix, the runtime
/// directory) the physical path is the guest path. A compiler invoked from a
/// workspace therefore keeps that workspace instead of starting in /.
///
/// A directory that belongs to the host alone is replaced by the configured
/// default. An explicit --guest-cwd is handled before this function and wins
/// in every case.
pub fn guest_cwd_for(cfg: &Config, rootfs: &Rootfs, pwd: &Path) -> String {
    let physical = pwd.to_string_lossy();
    if !rootfs.enabled() {
        return physical.into_owned();
    }
    if rootfs.contains(pwd) {
        return rootfs.unmap(&physical);
    }
    if rootfs.passthrough(&physical) {
        return physical.into_owned();
    }
    cfg.guest_cwd.clone()
}

/// What the loader of one invocation has to look for.
pub struct LoaderSearch<'a> {
    /// Architecture of the program the guest asked for.
    pub target: Arch,
    /// Architecture of the process that actually loads libraries.
    pub execution: Arch,
    /// Physical path of the object whose DT_RPATH/DT_RUNPATH apply.
    pub main_elf: &'a Path,
    pub rpath: &'a [String],
    pub runpath: &'a [String],
    /// Guest-visible LD_LIBRARY_PATH, if the guest set one.
    pub guest_library_path: Option<&'a str>,
    pub guest_cwd: &'a str,
}

/// Physical loader search path for one invocation.
///
/// The order is the one glibc itself uses: the main object's DT_RPATH (only
/// when it has no DT_RUNPATH), the guest's LD_LIBRARY_PATH, its DT_RUNPATH,
/// then the rootfs' own default directories.
///
/// The guest list has to be translated because --library-path replaces
/// LD_LIBRARY_PATH for the loader: left alone, /opt/lib would be read as a
/// host directory. Directories that do not exist in the guest are dropped, so
/// a host-injected value cannot keep a host path alive.
///
/// One approximation follows from the loader's single --library-path list: the
/// translated RUNPATH is visible to indirect lookups as well, which is wider
/// than DT_RUNPATH's own scope. A dependency's own RPATH/RUNPATH is not
/// translated at all, so a dependency that relies on one still needs the guest
/// paths it names to be reachable another way.
pub fn loader_search_path(cfg: &Config, rootfs: &Rootfs, search: &LoaderSearch<'_>) -> Vec<String> {
    let mut dirs: Vec<String> = Vec::new();
    // Box64 resolves the target's libraries itself and reads its own guest
    // list from BOX64_LD_LIBRARY_PATH, so x86 paths must not reach the host
    // loader.
    if search.target == search.execution {
        let origin = search
            .main_elf
            .parent()
            .map(|dir| rootfs.unmap(&dir.to_string_lossy()))
            .unwrap_or_else(|| "/".to_string());
        let mut add = |entry: &str| {
            if let Some(dir) = map_search_entry(rootfs, entry, &origin, search.guest_cwd)
                && !dirs.contains(&dir)
            {
                dirs.push(dir);
            }
        };
        if search.runpath.is_empty() {
            for entry in search.rpath {
                add(entry);
            }
        }
        if let Some(list) = search.guest_library_path.filter(|list| !list.is_empty()) {
            for entry in list.split(':') {
                add(entry);
            }
        }
        for entry in search.runpath {
            add(entry);
        }
    }
    for dir in execution_library_path(cfg, search.target, search.execution) {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    dirs
}

/// Translate one loader search-path entry into a physical directory.
///
/// ORIGIN is expanded against the guest-visible directory of the main object.
/// Letting glibc expand it inside --library-path would use the loader's own
/// directory instead, which is not what the program's DT_RPATH meant.
fn map_search_entry(rootfs: &Rootfs, entry: &str, origin: &str, guest_cwd: &str) -> Option<String> {
    let expanded = entry
        .replace("${ORIGIN}", origin)
        .replace("$ORIGIN", origin);
    // LIB and PLATFORM depend on the loader's platform. Guessing them would
    // silently choose a directory the guest did not ask for.
    if expanded.contains('$') {
        return None;
    }
    let logical = if expanded.is_empty() {
        // An empty element means the current directory.
        normalize(guest_cwd)
    } else if expanded.starts_with('/') {
        normalize(&expanded)
    } else {
        normalize(&join_guest(guest_cwd, &expanded))
    };
    let physical = rootfs.physical(&logical);
    physical
        .is_dir()
        .then(|| physical.to_string_lossy().into_owned())
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

/// Box64 runs against host glibc, while its x86 libraries remain in the guest.
pub fn execution_library_path(cfg: &Config, target: Arch, execution: Arch) -> Vec<String> {
    if target == execution {
        return library_path(cfg, execution);
    }
    let mut dirs = Vec::new();
    let mut push = |path: PathBuf| {
        if path.is_dir() {
            let path = path.to_string_lossy().into_owned();
            if !dirs.contains(&path) {
                dirs.push(path);
            }
        }
    };
    if let Some(runtime) = &cfg.runtime_dir {
        push(runtime.join("lib"));
        for dir in execution.lib_dirs() {
            push(runtime.join(dir.trim_start_matches('/')));
        }
        push(runtime.join("usr/lib"));
    }
    if let Some(root) = &cfg.rootfs {
        for dir in execution.lib_dirs() {
            push(root.join(dir.trim_start_matches('/')));
        }
        for dir in ["lib", "usr/lib"] {
            let path = root.join(dir);
            if matches_arch(&path.join("libc.so.6"), execution) {
                push(path);
            }
        }
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

    #[test]
    fn empty_env_split_string_is_an_error_not_a_panic() {
        for rootfs in [false, true] {
            for arg in ["-S", "-S   ", "--split-string="] {
                assert!(shebang_command("/usr/bin/env".into(), Some(arg.into()), rootfs).is_err());
            }
        }
    }

    #[test]
    fn guest_env_receives_original_optional_argument_for_gnu_parsing() {
        let argument = r#"-S -u HOME NAME="two words" PATH=/custom/bin python3 -c 'print("a b")'"#;
        let (program, arguments, overrides) =
            shebang_command("/usr/bin/env".into(), Some(argument.into()), true).unwrap();
        assert_eq!(program, "/usr/bin/env");
        assert_eq!(arguments.unwrap(), vec![argument]);
        assert!(overrides.is_empty());
    }

    #[test]
    fn legacy_env_split_string_preserves_quotes_and_empty_arguments() {
        let (program, arguments, overrides) = shebang_command(
            "/usr/bin/env".into(),
            Some(r#"-S NAME="two words" python3 -c 'print("a b")' ''"#.into()),
            false,
        )
        .unwrap();
        assert_eq!(program, "python3");
        assert_eq!(arguments.unwrap(), vec!["-c", r#"print("a b")"#, ""]);
        assert_eq!(overrides, vec![("NAME".into(), "two words".into())]);
        assert!(split_legacy_env_words("'unterminated").is_err());
    }

    #[test]
    fn cwd_uses_actual_host_directory_without_rootfs() {
        let mut cfg = Config::from_env().unwrap();
        cfg.rootfs = None;
        let rootfs = Rootfs::from_config(&cfg);
        assert_eq!(
            guest_cwd_for(&cfg, &rootfs, Path::new("/actual/cwd")),
            "/actual/cwd"
        );
    }

    #[test]
    fn authorized_host_workspace_is_kept_for_rerouted_and_explicit_launches() {
        let tmp = tempfile::tempdir().unwrap();
        let mut cfg = Config::from_env().unwrap();
        cfg.rootfs = Some(tmp.path().join("rootfs"));
        cfg.guest_cwd = "/".into();
        let workspace = tmp.path().join("workspace");
        cfg.host_paths = vec![workspace.clone()];
        let rootfs = Rootfs::from_config(&cfg);
        // A compiler started by go in its build directory must keep that
        // directory, whether it arrived through the preload reroute or was
        // invoked directly.
        assert_eq!(
            guest_cwd_for(&cfg, &rootfs, &workspace),
            workspace.to_string_lossy()
        );
        assert_eq!(
            guest_cwd_for(&cfg, &rootfs, &cfg.rootfs.as_ref().unwrap().join("work")),
            "/work"
        );
        // A host-only directory is not visible to the guest, so the configured
        // default still applies.
        assert_eq!(guest_cwd_for(&cfg, &rootfs, Path::new("/host/only")), "/");
    }

    #[test]
    fn explicit_readable_non_executable_script_fails_with_126() {
        let script = write_temp(b"#!/bin/sh\necho not-executable\n");
        let name = script.path().to_str().unwrap();
        let error = resolve(name, &[name.into()], "/", false)
            .err()
            .expect("non-executable script must fail");
        assert!(matches!(error, Error::PermissionDenied(_)));
        assert_eq!(error.exit_code(), 126);
    }

    #[test]
    fn architecture_plan_separates_target_from_kernel_execution_architecture() {
        for arch in [Arch::Aarch64, Arch::X86_64] {
            let plan = architecture_plan(arch, Libc::Glibc, arch, None).unwrap();
            assert_eq!(plan.target, arch);
            assert_eq!(plan.execution, arch);
        }
    }

    fn arm64_box64_info() -> elf::ElfInfo {
        elf::ElfInfo {
            machine: elf::EM_AARCH64,
            libc: Libc::Glibc,
            interpreter: Some("/lib/ld-linux-aarch64.so.1".into()),
            dynamic: true,
            rpath: Vec::new(),
            runpath: Vec::new(),
        }
    }

    #[test]
    fn box64_plan_uses_host_architecture_and_its_own_argv0() {
        let box64 = arm64_box64_info();
        let plan =
            architecture_plan(Arch::X86_64, Libc::Glibc, Arch::Aarch64, Some(&box64)).unwrap();
        assert_eq!(plan.target, Arch::X86_64);
        assert_eq!(plan.execution, Arch::Aarch64);
        let argv = execution_argv(
            Path::new("/guest/program"),
            &["custom-target-argv0".into(), "arg".into()],
            Some(Path::new("/host/box64-glibc")),
        );
        assert_eq!(argv, vec!["/host/box64-glibc", "/guest/program", "arg"]);
    }

    #[test]
    fn box64_plan_rejects_invalid_emulator_and_unsupported_direction() {
        let mut box64 = arm64_box64_info();
        assert!(matches!(
            architecture_plan(Arch::X86_64, Libc::Glibc, Arch::Aarch64, None),
            Err(Error::NoBox64)
        ));
        box64.machine = elf::EM_X86_64;
        assert!(matches!(
            architecture_plan(Arch::X86_64, Libc::Glibc, Arch::Aarch64, Some(&box64)),
            Err(Error::Unsupported(_))
        ));
        box64.machine = elf::EM_AARCH64;
        box64.libc = Libc::Bionic;
        assert!(matches!(
            architecture_plan(Arch::X86_64, Libc::Glibc, Arch::Aarch64, Some(&box64)),
            Err(Error::Unsupported(_))
        ));
        assert!(matches!(
            architecture_plan(Arch::Aarch64, Libc::Glibc, Arch::X86_64, Some(&box64)),
            Err(Error::Unsupported(_))
        ));
        assert!(matches!(
            architecture_plan(Arch::X86_64, Libc::Static, Arch::Aarch64, Some(&box64)),
            Err(Error::Unsupported(_))
        ));
    }

    #[test]
    fn box64_host_loader_and_library_paths_do_not_use_x86_guest_libraries() {
        let tmp = tempfile::tempdir().unwrap();
        let mut cfg = Config::from_env().unwrap();
        cfg.loader = None;
        cfg.rootfs = Some(tmp.path().join("guest"));
        cfg.runtime_dir = Some(tmp.path().join("native-runtime"));
        let root = cfg.rootfs.as_ref().unwrap();
        let runtime = cfg.runtime_dir.as_ref().unwrap();
        for dir in [
            root.join("lib/x86_64-linux-gnu"),
            root.join("lib/aarch64-linux-gnu"),
            runtime.join("lib"),
        ] {
            std::fs::create_dir_all(dir).unwrap();
        }
        let loader = runtime.join("lib/ld-linux-aarch64.so.1");
        std::fs::write(&loader, b"host-loader-fixture").unwrap();
        assert_eq!(
            find_host_loader(
                &cfg,
                "/bionilux-test-missing/lib/ld-linux-aarch64.so.1",
                Arch::Aarch64
            ),
            Some(loader)
        );
        let paths = execution_library_path(&cfg, Arch::X86_64, Arch::Aarch64);
        assert!(paths.contains(&runtime.join("lib").display().to_string()));
        assert!(paths.contains(&root.join("lib/aarch64-linux-gnu").display().to_string()));
        assert!(!paths.contains(&root.join("lib/x86_64-linux-gnu").display().to_string()));
        assert!(!paths.contains(&root.join("lib").display().to_string()));
        assert!(
            library_path(&cfg, Arch::X86_64)
                .contains(&root.join("lib/x86_64-linux-gnu").display().to_string())
        );
    }

    #[test]
    fn no_preload_plan_and_custom_argv0_do_not_require_hook_library() {
        let executable = env::current_exe().unwrap();
        let name = executable.to_str().unwrap();
        let plan = resolve(name, &["custom-argv0".into(), "arg".into()], "/", false).unwrap();
        assert!(plan.preload.is_none());
        assert_eq!(plan.arch, Arch::host());
        assert_eq!(plan.execution_arch, Arch::host());
        assert_eq!(plan.argv, vec!["custom-argv0", "arg"]);
    }

    #[test]
    fn script_does_not_apply_original_argv0_to_its_interpreter() {
        use std::os::unix::fs::PermissionsExt;
        let interpreter = env::current_exe().unwrap();
        let script = write_temp(format!("#!{}\n", interpreter.display()).as_bytes());
        std::fs::set_permissions(script.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        let plan = resolve(
            script.path().to_str().unwrap(),
            &["script-custom-argv0".into(), "arg".into()],
            "/",
            false,
        )
        .unwrap();
        assert_eq!(plan.argv[0], interpreter.to_string_lossy());
        assert_eq!(plan.argv[1], script.path().to_string_lossy());
        assert_eq!(plan.argv[2], "arg");
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

    // ── loader search paths ────────────────────────────────────────

    fn rootfs_fixture(dirs: &[&str]) -> (tempfile::TempDir, Config, Rootfs) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("rootfs");
        for dir in dirs {
            std::fs::create_dir_all(root.join(dir.trim_start_matches('/'))).unwrap();
        }
        let mut cfg = Config::from_env().unwrap();
        cfg.rootfs = Some(root);
        cfg.prefix = None;
        cfg.runtime_dir = None;
        cfg.host_paths.clear();
        cfg.guest_cwd = "/".into();
        let rootfs = Rootfs::from_config(&cfg);
        (tmp, cfg, rootfs)
    }

    fn physical(cfg: &Config, relative: &str) -> String {
        cfg.rootfs
            .as_ref()
            .unwrap()
            .join(relative)
            .display()
            .to_string()
    }

    #[test]
    fn rpath_precedes_library_path_and_origin_names_the_main_object_directory() {
        let (_tmp, cfg, rootfs) =
            rootfs_fixture(&["opt/app/bin", "opt/app/lib", "opt/rpath", "opt/ld"]);
        let elf = cfg.rootfs.as_ref().unwrap().join("opt/app/bin/app");
        let rpath = ["$ORIGIN/../lib".to_string(), "/opt/rpath".to_string()];
        let dirs = loader_search_path(
            &cfg,
            &rootfs,
            &LoaderSearch {
                target: Arch::host(),
                execution: Arch::host(),
                main_elf: &elf,
                rpath: &rpath,
                runpath: &[],
                guest_library_path: Some("/opt/ld"),
                guest_cwd: "/",
            },
        );
        assert_eq!(dirs[0], physical(&cfg, "opt/app/lib"));
        assert_eq!(dirs[1], physical(&cfg, "opt/rpath"));
        assert!(dirs.contains(&physical(&cfg, "opt/ld")));
    }

    #[test]
    fn runpath_replaces_rpath_and_follows_library_path() {
        let (_tmp, cfg, rootfs) =
            rootfs_fixture(&["opt/bin", "opt/rpath", "opt/runpath", "opt/ld"]);
        let elf = cfg.rootfs.as_ref().unwrap().join("opt/bin/app");
        let rpath = ["/opt/rpath".to_string()];
        let runpath = ["/opt/runpath".to_string()];
        let dirs = loader_search_path(
            &cfg,
            &rootfs,
            &LoaderSearch {
                target: Arch::host(),
                execution: Arch::host(),
                main_elf: &elf,
                rpath: &rpath,
                runpath: &runpath,
                guest_library_path: Some("/opt/ld"),
                guest_cwd: "/",
            },
        );
        let library = dirs
            .iter()
            .position(|dir| dir == &physical(&cfg, "opt/ld"))
            .expect("guest LD_LIBRARY_PATH directory");
        let runpath = dirs
            .iter()
            .position(|dir| dir == &physical(&cfg, "opt/runpath"))
            .expect("mapped DT_RUNPATH directory");
        assert!(library < runpath, "LD_LIBRARY_PATH must precede DT_RUNPATH");
        assert!(
            !dirs.contains(&physical(&cfg, "opt/rpath")),
            "DT_RPATH is ignored when DT_RUNPATH is present"
        );
    }

    #[test]
    fn missing_guest_directories_are_dropped_and_entries_are_deduplicated() {
        let (_tmp, cfg, rootfs) = rootfs_fixture(&["opt/ld", "opt/app"]);
        let elf = cfg.rootfs.as_ref().unwrap().join("opt/app/tool");
        let dirs = loader_search_path(
            &cfg,
            &rootfs,
            &LoaderSearch {
                target: Arch::host(),
                execution: Arch::host(),
                main_elf: &elf,
                rpath: &[],
                runpath: &[],
                guest_library_path: Some("/opt/ld:/opt/ld:/opt/missing::"),
                guest_cwd: "/opt/app",
            },
        );
        assert_eq!(
            dirs.iter()
                .filter(|dir| **dir == physical(&cfg, "opt/ld"))
                .count(),
            1
        );
        assert!(dirs.contains(&physical(&cfg, "opt/app")));
        assert!(!dirs.iter().any(|dir| dir.contains("missing")));
    }

    #[test]
    fn box64_does_not_hand_guest_library_paths_to_the_host_loader() {
        let (_tmp, cfg, rootfs) = rootfs_fixture(&["opt/ld", "opt/rpath"]);
        let elf = cfg.rootfs.as_ref().unwrap().join("opt/app");
        let rpath = ["/opt/rpath".to_string()];
        let dirs = loader_search_path(
            &cfg,
            &rootfs,
            &LoaderSearch {
                target: Arch::X86_64,
                execution: Arch::Aarch64,
                main_elf: &elf,
                rpath: &rpath,
                runpath: &[],
                guest_library_path: Some("/opt/ld"),
                guest_cwd: "/",
            },
        );
        assert!(!dirs.contains(&physical(&cfg, "opt/ld")));
        assert!(!dirs.contains(&physical(&cfg, "opt/rpath")));
    }

    #[test]
    fn only_the_rootfs_loader_is_recognised_as_a_loader() {
        let (_tmp, cfg, _rootfs) = rootfs_fixture(&["lib64", "bin"]);
        let root = cfg.rootfs.as_ref().unwrap();
        let arch = Arch::host();
        assert!(is_guest_loader(
            &cfg,
            &root.join("lib64").join(arch.loader_name()),
            arch
        ));
        let elsewhere = Path::new("/usr/lib").join(arch.loader_name());
        assert!(!is_guest_loader(&cfg, &elsewhere, arch));
        assert!(!is_guest_loader(&cfg, &root.join("bin/sh"), arch));
    }
}
