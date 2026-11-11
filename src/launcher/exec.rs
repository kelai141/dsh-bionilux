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

    #[cfg(target_os = "android")]
    {
        run_traced(&exec_path, &c_args, &c_env);
    }

    #[cfg(not(target_os = "android"))]
    {
        // execve only returns on failure.
        let e = execve(&exec_path, &c_args, &c_env).unwrap_err();
        let code = match e {
            nix::errno::Errno::ENOENT => 127,
            nix::errno::Errno::EACCES => 126,
            _ => 1,
        };
        // EACCES covers a missing permission bit and a denied exec. On Android the
        // second is what an app sees for an ELF it owns, so name the cause instead
        // of letting it look like a chmod problem.
        match e {
            nix::errno::Errno::EACCES => eprintln!(
                "[ERROR] execve failed: {e} ({}): {HINT}",
                exec_path.to_string_lossy()
            ),
            _ => eprintln!("[ERROR] execve failed: {e}"),
        }
        std::process::exit(code);
    }
}

/// Run the guest under a ptrace supervisor that drops `SIGSYS`.
///
/// Android's app seccomp policy traps syscalls a stock glibc startup makes
/// (`set_robust_list`, `rseq`) and turns them into `SIGSYS`, which kills the
/// loader before any constructor can install a handler. Suppressing the signal
/// lets the kernel's `-ENOSYS` stand, which glibc tolerates.
///
/// The supervisor also follows fork/vfork/clone, so guest children are covered.
#[cfg(target_os = "android")]
fn run_traced(exec_path: &CString, c_args: &[CString], c_env: &[CString]) -> ! {
    use nix::sys::ptrace::{self, Options};
    use nix::sys::signal::Signal;
    use nix::sys::wait::{waitpid, WaitStatus};
    use nix::unistd::ForkResult;

    match unsafe { nix::unistd::fork() } {
        Ok(ForkResult::Child) => {
            // Die with the supervisor so a killed launcher leaves no orphan.
            unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL as libc::c_ulong) };
            let _ = ptrace::traceme();
            let _ = execve(exec_path, c_args, c_env);
            std::process::exit(126);
        }
        Ok(ForkResult::Parent { child }) => {
            // Wait for the exec stop before arming fork tracking.
            loop {
                match waitpid(child, None) {
                    Ok(WaitStatus::Stopped(_, _)) | Ok(WaitStatus::PtraceEvent(_, _, _)) => break,
                    Ok(WaitStatus::Exited(_, code)) => std::process::exit(code),
                    Ok(WaitStatus::Signaled(_, sig, _)) => std::process::exit(128 + sig as i32),
                    Ok(_) => continue,
                    Err(_) => std::process::exit(1),
                }
            }
            let opts = Options::PTRACE_O_TRACEFORK
                | Options::PTRACE_O_TRACEVFORK
                | Options::PTRACE_O_TRACECLONE
                | Options::PTRACE_O_TRACEEXEC;
            let _ = ptrace::setoptions(child, opts);
            let _ = ptrace::cont(child, None);

            let exit_code = loop {
                match waitpid(None, None) {
                    Ok(WaitStatus::Exited(pid, code)) => {
                        if pid == child {
                            break code;
                        }
                    }
                    Ok(WaitStatus::Signaled(pid, sig, _)) => {
                        if pid == child {
                            break 128 + sig as i32;
                        }
                    }
                    Ok(WaitStatus::Stopped(pid, sig)) => {
                        // SIGSYS from the seccomp trap, and the SIGSTOP a freshly
                        // traced child gets, are both dropped. Dropping SIGSTOP
                        // costs guest job control, which a batch runner does not
                        // need.
                        let pass = if matches!(sig, Signal::SIGSYS | Signal::SIGSTOP) {
                            None
                        } else {
                            Some(sig)
                        };
                        let _ = ptrace::cont(pid, pass);
                    }
                    Ok(WaitStatus::PtraceEvent(pid, _, _)) | Ok(WaitStatus::PtraceSyscall(pid)) => {
                        let _ = ptrace::cont(pid, None);
                    }
                    Ok(_) => {}
                    Err(_) => break 1,
                }
            };
            std::process::exit(exit_code);
        }
        Err(e) => {
            eprintln!("[ERROR] fork failed: {e}");
            std::process::exit(1);
        }
    }
}

#[cfg(not(target_os = "android"))]
const HINT: &str = "the kernel refused this exec. An Android app may execute \
    only apk_data_file (nativeLibraryDir); app data and memfd are readable and \
    mappable but not executable. Install the loader in the APK native library \
    directory, or start the launcher through /system/bin/linker64.";

fn cstring_arg(s: &str, what: &str) -> Result<CString, String> {
    CString::new(s).map_err(|_| format!("{what} contains a NUL byte"))
}

fn cstring_path(p: &Path) -> Result<CString, String> {
    let s = p
        .to_str()
        .ok_or_else(|| format!("non-UTF-8 path: {}", p.display()))?;
    CString::new(s).map_err(|_| format!("path contains a NUL byte: {}", p.display()))
}
