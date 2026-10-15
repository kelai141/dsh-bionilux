use nix::unistd::execve;
use std::ffi::CString;
use std::path::Path;

use crate::debug;

/// Options that shape how the loader is invoked.
pub struct ExecSpec<'a> {
    /// Path handed to `execve`. For a glibc target this is the loader.
    pub exec_target: &'a Path,
    /// glibc loader, or `None` for a host-native binary.
    pub loader: Option<&'a Path>,
    /// argv[0..] as the guest should see it.
    pub argv: &'a [String],
    pub env: &'a [String],
    /// Working directory to enter first, already mapped to a physical path.
    pub chdir_to: Option<&'a Path>,
    /// Directories the loader should search, as *physical* paths.
    ///
    /// Passed on the command line rather than through `LD_LIBRARY_PATH` so an
    /// inherited value — which points into the host user space — cannot leak
    /// in, and so a Bionic child never sees glibc directories on its own
    /// linker search path.
    pub library_path: &'a [String],
}

/// Replace the current process with the resolved target.
///
/// Returns `Err` only if the request could not be prepared (NUL byte,
/// non-UTF-8 path). On a successful `execve` the process is replaced and this
/// never returns.
pub fn execute(spec: &ExecSpec<'_>) -> Result<(), String> {
    if let Some(dir) = spec.chdir_to {
        std::env::set_current_dir(dir)
            .map_err(|e| format!("cannot enter {}: {e}", dir.display()))?;
    }

    let argv0 = spec.argv.first().map(String::as_str).unwrap_or("");
    let c_env: Vec<CString> = spec
        .env
        .iter()
        .map(|e| cstring_arg(e, "environment entry"))
        .collect::<Result<_, _>>()?;
    let c_target = cstring_path(spec.exec_target)?;

    let (exec_path, c_args): (CString, Vec<CString>) = match spec.loader {
        Some(ld) => {
            let c_ld = cstring_path(ld)?;
            let mut v = Vec::with_capacity(spec.argv.len() + 4 + spec.library_path.len() * 2);
            v.push(c_ld.clone());
            if !spec.library_path.is_empty() {
                v.push(CString::new("--library-path").unwrap());
                v.push(cstring_arg(&spec.library_path.join(":"), "library path")?);
            }
            v.push(CString::new("--argv0").unwrap());
            v.push(cstring_arg(argv0, "argv[0]")?);
            v.push(c_target);
            for a in spec.argv.iter().skip(1) {
                v.push(cstring_arg(a, "argument")?);
            }
            (c_ld, v)
        }
        None => {
            let v = spec
                .argv
                .iter()
                .map(|a| cstring_arg(a, "argument"))
                .collect::<Result<_, _>>()?;
            (c_target, v)
        }
    };

    debug!("execve: {}", exec_path.to_string_lossy());

    // execve only returns on failure.
    let e = execve(&exec_path, &c_args, &c_env).unwrap_err();
    let code = match e {
        nix::errno::Errno::ENOENT => 127,
        nix::errno::Errno::EACCES => 126,
        _ => 1,
    };
    eprintln!("[ERROR] execve failed: {e}");
    std::process::exit(code);
}

fn cstring_arg(s: &str, what: &str) -> Result<CString, String> {
    CString::new(s).map_err(|_| format!("{what} contains a NUL byte"))
}

fn cstring_path(p: &Path) -> Result<CString, String> {
    let s = p
        .to_str()
        .ok_or_else(|| format!("non-UTF-8 path: {}", p.display()))?;
    CString::new(s).map_err(|_| format!("path contains a NUL byte: {}", p.display()))
}
