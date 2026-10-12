use nix::unistd::execve;
use std::ffi::CString;
use std::path::Path;

use crate::debug;

// Replace the current process with exec_target.
// With a loader: execve(loader, [loader, --argv0, argv[0], exec_target, args[1..]]).
// Without:       execve(exec_target, argv).
pub fn execute(
    exec_target: &Path,
    loader: Option<&Path>,
    argv: &[String],
    env: &[String],
    chdir_to: Option<&Path>,
) {
    if let Some(dir) = chdir_to {
        let _ = std::env::set_current_dir(dir);
    }

    let argv0 = argv.first().map(String::as_str).unwrap_or("");
    let c_env: Vec<CString> = env.iter().map(|e| cstring(e)).collect();
    let c_target = cstring(path_str(exec_target));

    let (exec_path, c_args): (CString, Vec<CString>) = match loader {
        Some(ld) => {
            let c_ld = cstring(path_str(ld));
            let mut v = Vec::with_capacity(argv.len() + 3);
            v.push(c_ld.clone());
            v.push(cstring("--argv0"));
            v.push(cstring(argv0));
            v.push(c_target);
            v.extend(argv.iter().skip(1).map(|a| cstring(a)));
            (c_ld, v)
        }
        None => {
            let v = argv.iter().map(|a| cstring(a)).collect();
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

// Exit cleanly instead of panicking on NUL bytes.
fn cstring(s: &str) -> CString {
    CString::new(s).unwrap_or_else(|_| {
        eprintln!("[ERROR] argument contains NUL byte");
        std::process::exit(1);
    })
}

fn path_str(p: &Path) -> &str {
    p.to_str().unwrap_or_else(|| {
        eprintln!("[ERROR] non-UTF-8 path: {}", p.display());
        std::process::exit(1);
    })
}
