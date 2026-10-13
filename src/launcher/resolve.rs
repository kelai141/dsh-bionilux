use std::env;
use std::fmt;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::analyzer::elf::{self, EM_AARCH64, EM_X86_64, Libc};
use crate::debug;

const GLIBC_DIR: &str = "/data/data/com.termux/files/usr/glibc";
const BOX64: &str = "/data/data/com.termux/files/usr/bionilux/box64-glibc";
const LOADER: &str = "/lib/ld-linux-aarch64.so.1";
const TERMUX_BIN: &str = "/data/data/com.termux/files/usr/bin/";
const MAX_SHEBANG_DEPTH: u32 = 4;

pub struct Execution {
    pub exec_target: PathBuf,
    pub original_target: PathBuf,
    pub argv: Vec<String>,
    pub loader: Option<PathBuf>,
    pub preload: Option<PathBuf>,
    pub is_x86_64: bool,
}

pub enum Error {
    NotFound(String),
    NoPreload,
    NoBox64,
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
            Error::NoPreload => write!(f, "libbionilux_preload.so not found"),
            Error::NoBox64 => write!(f, "box64 not found at {BOX64}"),
            Error::Unsupported(m) => write!(f, "unsupported: {m}"),
        }
    }
}

// Four outcomes: native, glibc-aarch64 (loader), glibc-x86_64 (box64), shebang.
pub fn resolve(raw: &str, args: &[String]) -> Result<Execution, Error> {
    resolve_at(raw, args, 0)
}

fn resolve_at(raw: &str, args: &[String], depth: u32) -> Result<Execution, Error> {
    let target = which::which(raw).map_err(|_| Error::NotFound(raw.into()))?;
    debug!("resolved: {}", target.display());

    let Some(info) = elf::analyze(&target) else {
        return script(&target, args, depth);
    };

    if matches!(info.libc, Libc::Musl | Libc::Other) {
        return Err(Error::Unsupported(format!("libc {:?}", info.libc)));
    }

    if info.machine != EM_X86_64 && info.machine != EM_AARCH64 {
        return Err(Error::Unsupported(format!("machine 0x{:x}", info.machine)));
    }

    let is_x86 = info.machine == EM_X86_64;
    let is_native = matches!(info.libc, Libc::Bionic | Libc::Static);

    if is_native {
        if is_x86 {
            return Err(Error::Unsupported("x86_64 static/bionic".into()));
        }
        debug!("native");
        return Ok(Execution {
            exec_target: target.clone(),
            original_target: target,
            argv: args.to_vec(),
            loader: None,
            preload: None,
            is_x86_64: false,
        });
    }

    // Needs the glibc loader; x86_64 also needs box64 in front.
    let (exec_target, argv) = if is_x86 {
        let box64 = PathBuf::from(BOX64);
        if !box64.exists() {
            return Err(Error::NoBox64);
        }
        debug!("x86_64 glibc -> box64");
        // argv[0] must be box64's full path — box64 uses it to find itself.
        let mut v = vec![BOX64.to_string(), target.display().to_string()];
        v.extend(args.iter().skip(1).cloned());
        (box64, v)
    } else {
        debug!("aarch64 glibc -> loader");
        (target.clone(), args.to_vec())
    };

    let interp = if is_x86 {
        LOADER.to_string()
    } else {
        info.interpreter.clone().unwrap_or(LOADER.into())
    };
    let loader = find_loader(&interp)
        .ok_or_else(|| Error::Unsupported(format!("loader {interp} missing")))?;
    let preload = find_preload().ok_or(Error::NoPreload)?;

    Ok(Execution {
        exec_target,
        original_target: target,
        argv,
        loader: Some(loader),
        preload: Some(preload),
        is_x86_64: is_x86,
    })
}

// Ubuntu PT_INTERP says /lib/...; Termux stores it under $GLIBC/lib.
fn find_loader(interp: &str) -> Option<PathBuf> {
    let p = PathBuf::from(interp);
    if p.exists() {
        return Some(p);
    }
    let name = p.file_name()?;
    let alt = Path::new(GLIBC_DIR).join("lib").join(name);
    alt.exists().then_some(alt)
}

fn find_preload() -> Option<PathBuf> {
    if let Ok(p) = env::var("BIONILUX_PRELOAD") {
        let p = PathBuf::from(p);
        if p.exists() {
            return Some(p);
        }
    }
    // Walk up from the current exe (dev: target/debug/bionilux -> project root).
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
    // Installed alongside glibc.
    let p = Path::new(GLIBC_DIR).join("lib/libbionilux_preload.so");
    p.exists().then_some(p)
}

// Shebang script: resolve the interpreter, then rebuild argv.
fn script(script: &Path, args: &[String], depth: u32) -> Result<Execution, Error> {
    if depth >= MAX_SHEBANG_DEPTH {
        return Err(Error::Unsupported("shebang recursion too deep".into()));
    }

    let (interp, interp_arg) =
        parse_shebang(script).ok_or_else(|| Error::Unsupported("not ELF or shebang".into()))?;

    let interp = rewrite_termux(&interp);

    // `#!/usr/bin/env prog` — resolve prog directly instead of running env,
    // because env is native bionic and would bypass our rerouting.
    // `-S` variant splits remaining words as separate arguments.
    let (interp, interp_args): (String, Option<Vec<String>>) =
        if Path::new(&interp).file_name() == Some("env".as_ref()) {
            let arg = interp_arg
                .ok_or_else(|| Error::Unsupported("env shebang without program".into()))?;
            let mut words: Vec<String> = arg.split_whitespace().map(String::from).collect();
            if words.is_empty() {
                return Err(Error::Unsupported("env shebang without program".into()));
            }
            if words[0] == "-S" {
                words.remove(0);
                if words.is_empty() {
                    return Err(Error::Unsupported("env -S without program".into()));
                }
            }
            let prog = words.remove(0);
            let rest = if words.is_empty() { None } else { Some(words) };
            (prog, rest)
        } else {
            (interp, interp_arg.map(|a| vec![a]))
        };

    let interp_path = which::which(&interp)
        .map_err(|_| Error::Unsupported(format!("shebang interp not found: {interp}")))?;

    // Resolve the interpreter — may itself be glibc, box64-wrapped, or native.
    let interp_str = interp_path
        .to_str()
        .ok_or_else(|| Error::Unsupported("non-UTF-8 interpreter path".into()))?;
    let inner = resolve_at(interp_str, std::slice::from_ref(&interp), depth + 1)?;

    // Start from inner.argv — preserves [BOX64, interp] for x86_64 interpreters.
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
        is_x86_64: inner.is_x86_64,
    })
}

// Termux has no /bin or /usr/bin.
fn rewrite_termux(p: &str) -> String {
    for prefix in ["/bin/", "/usr/bin/"] {
        if let Some(rest) = p.strip_prefix(prefix) {
            return format!("{TERMUX_BIN}{rest}");
        }
    }
    p.to_string()
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    // ── rewrite_termux ──────────────────────────────────────────────

    #[test]
    fn rewrite_bin_prefix() {
        assert_eq!(rewrite_termux("/bin/sh"), format!("{TERMUX_BIN}sh"));
    }

    #[test]
    fn rewrite_usr_bin_prefix() {
        assert_eq!(
            rewrite_termux("/usr/bin/python3"),
            format!("{TERMUX_BIN}python3")
        );
    }

    #[test]
    fn rewrite_leaves_other_paths_alone() {
        assert_eq!(rewrite_termux("/opt/foo/bar"), "/opt/foo/bar");
        assert_eq!(rewrite_termux("sh"), "sh");
        assert_eq!(rewrite_termux("/usr/local/bin/x"), "/usr/local/bin/x");
    }

    // ── parse_shebang ───────────────────────────────────────────────

    fn write_temp(content: &[u8]) -> NamedTempFile {
        let mut f = NamedTempFile::new().unwrap();
        f.write_all(content).unwrap();
        f.flush().unwrap();
        f
    }

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

    // ── find_loader ─────────────────────────────────────────────────

    #[test]
    fn find_loader_missing() {
        assert!(find_loader("/nonexistent/foo/ld-fake.so").is_none());
    }

    #[test]
    fn find_loader_falls_back_to_glibc_dir() {
        let fallback = Path::new(GLIBC_DIR)
            .join("lib")
            .join("ld-linux-aarch64.so.1");
        let result = find_loader(LOADER);
        if fallback.exists() {
            assert_eq!(result.as_deref(), Some(fallback.as_path()));
        } else {
            assert!(result.is_none());
        }
    }
}
