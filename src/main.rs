use clap::{CommandFactory, Parser};
use std::env;
use std::process::exit;

mod analyzer;
mod debug;
mod launcher;

#[derive(Parser, Debug)]
#[command(
    name = "bionilux",
    version,
    about = "Run glibc Linux binaries, including a full Debian rootfs, without an emulator",
    disable_help_subcommand = true,
    after_help = "Guest path semantics (--rootfs):\n  \
        /x refers to <rootfs>/x, and fails if it does not exist there.\n  \
        Host paths are never substituted for missing guest paths.\n\n\
        Examples:\n  \
        bionilux ./my_binary                     # glibc or x86_64, auto-detected\n  \
        bionilux --rootfs /data/.../rootfs /bin/bash\n  \
        bionilux --rootfs /data/.../rootfs --guest-cwd /root /usr/bin/apt-get update\n  \
        bionilux --print-config                  # resolved runtime identity\n  \
        BIONILUX_DEBUG=1 bionilux ./my_app       # verbose\n  \
        bionilux -n ./static_glibc_binary        # skip preload injection\n  \
        bionilux ls -la                          # pass args through"
)]
struct Cli {
    /// Print debug output to stderr
    #[arg(short, long)]
    debug: bool,

    /// Skip LD_PRELOAD injection (no child rerouting, no guest path mapping)
    #[arg(short = 'n', long = "no-preload")]
    no_preload: bool,

    /// Guest file system root. Enables Linux path semantics for /usr, /etc, ...
    #[arg(long, value_name = "DIR")]
    rootfs: Option<String>,

    /// Guest working directory to start in (default: /)
    #[arg(long, value_name = "DIR")]
    guest_cwd: Option<String>,

    /// Guest PATH, colon separated
    #[arg(long, value_name = "LIST")]
    guest_path: Option<String>,

    /// Expose a host directory to the guest at the same absolute path
    /// (Android public storage, an app's private directory). Repeatable.
    #[arg(long = "host-path", value_name = "DIR")]
    host_path: Vec<String>,

    /// Do not expose Android's public storage (/sdcard, /storage/emulated/0)
    #[arg(long = "no-android-paths")]
    no_android_paths: bool,

    /// Print the resolved runtime identity and exit
    #[arg(long = "print-config")]
    print_config: bool,

    /// Original argv[0] supplied by the preload reroute protocol.
    #[arg(long, hide = true, global = true, allow_hyphen_values = true)]
    argv0: Option<String>,

    /// Target binary to run, followed by its arguments.
    ///
    /// Collected as one trailing list so the launcher's own flags cannot
    /// swallow an argument meant for the target: `bionilux grep -n ...` must
    /// pass `-n` to grep, not treat it as `--no-preload`.
    #[arg(
        value_name = "COMMAND",
        trailing_var_arg = true,
        allow_hyphen_values = true
    )]
    command: Vec<String>,
}

/// Push command line overrides into the environment before the configuration
/// is read for the first time. Single threaded at this point: no other thread
/// can observe the mutation.
fn apply_overrides(cli: &Cli) {
    let pairs = [
        (launcher::config::env_keys::ROOTFS, cli.rootfs.as_deref()),
        (
            launcher::config::env_keys::GUEST_CWD,
            cli.guest_cwd.as_deref(),
        ),
        (
            launcher::config::env_keys::GUEST_PATH,
            cli.guest_path.as_deref(),
        ),
        (
            launcher::config::env_keys::INTERNAL_ARGV0,
            cli.argv0.as_deref(),
        ),
    ];
    for (key, value) in pairs {
        if let Some(value) = value {
            // SAFETY: called before any thread is spawned and before the
            // configuration cache is initialized.
            unsafe { env::set_var(key, value) };
        }
    }
    if launcher::config::is_rerouted()
        && let Some(path) = &cli.guest_path
    {
        // An explicit launcher override still wins over a rerouted child's PATH.
        unsafe { env::set_var("PATH", path) };
    }
    if !cli.host_path.is_empty() {
        // Append to whatever the caller already exported rather than replacing
        // it: the environment is the plugin's configuration channel.
        let mut list = env::var(launcher::config::env_keys::HOST_PATHS).unwrap_or_default();
        for path in &cli.host_path {
            if !list.is_empty() {
                list.push(':');
            }
            list.push_str(path);
        }
        // SAFETY: as above.
        unsafe { env::set_var(launcher::config::env_keys::HOST_PATHS, list) };
    }
    if cli.no_android_paths {
        // SAFETY: as above.
        unsafe { env::set_var(launcher::config::env_keys::ANDROID_PATHS, "0") };
    }
}

fn launch_cwd(
    cfg: &launcher::config::Config,
    rootfs: &launcher::rootfs::Rootfs,
    pwd: &std::path::Path,
    explicit: Option<&str>,
) -> Result<String, String> {
    if let Some(cwd) = explicit {
        if !cwd.starts_with('/') {
            return Err(format!("guest working directory must be absolute: {cwd}"));
        }
        Ok(launcher::config::normalize(cwd))
    } else {
        Ok(launcher::resolve::guest_cwd_for(cfg, rootfs, pwd))
    }
}

/// The guest cwd this invocation was explicitly told to use.
///
/// --guest-cwd always wins. An inherited BIONILUX_GUEST_CWD is configuration
/// only for the first entry: once a session runs (marker set, or the preload
/// reroute), that variable just records where the current process is, so a
/// launcher call from a different physical directory must not be dragged back
/// to it. The physical cwd decides in that case, and the same value remains the
/// configured fallback.
fn configured_guest_cwd(
    cli: Option<&str>,
    inherited: Option<String>,
    rerouted: bool,
    session: bool,
) -> Option<String> {
    if let Some(cwd) = cli {
        return Some(cwd.to_string());
    }
    if rerouted || session {
        return None;
    }
    inherited.filter(|cwd| !cwd.is_empty())
}

/// Path children should use to re-enter this launcher. Under the Android
/// system linker /proc/self/exe names the linker but argv[0] names bionilux.
fn launcher_identity(current_exe: &std::path::Path) -> Result<std::path::PathBuf, String> {
    launcher_identity_from(
        current_exe,
        std::env::args_os().map(std::path::PathBuf::from),
    )
    .ok_or_else(|| "cannot identify bionilux under the system linker; use its absolute path".into())
}

fn launcher_identity_from(
    current_exe: &std::path::Path,
    args: impl IntoIterator<Item = std::path::PathBuf>,
) -> Option<std::path::PathBuf> {
    let linker = current_exe
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == "linker64" || name == "linker");
    if !linker {
        return Some(current_exe.to_path_buf());
    }
    // argv[0] wins on Android 15. Accept argv[1] only if it also really names
    // a launcher, for linkers which retain their own name in argv[0]. Never
    // fall back to the guest target: that would make every child re-enter it.
    args.into_iter().take(2).find(|path| is_launcher_path(path))
}

fn is_launcher_path(path: &std::path::Path) -> bool {
    path.is_absolute() && path.is_file() && path.file_name().is_some_and(|name| name == "bionilux")
}

/// Guest path of the program, as /proc/self/exe should report it.
///
/// The kernel reports the resolved file, not the name that was typed, so a
/// symlinked entry point (/usr/local/bin/dart, for example) has to be
/// canonicalised before it is unmapped. Tools derive their install layout from
/// that path; reporting the link would send them looking in the wrong place.
/// The canonical path is used only when it stays inside the rootfs, so a link
/// that escapes cannot turn into a host path.
fn guest_target(original: &std::path::Path, rootfs: &launcher::rootfs::Rootfs) -> String {
    let canonical = original.canonicalize().ok();
    let chosen = canonical
        .filter(|path| !rootfs.enabled() || rootfs.contains(path))
        .unwrap_or_else(|| original.to_path_buf());
    rootfs.unmap(&chosen.to_string_lossy())
}

fn main() {
    let cli = Cli::parse();
    debug::init(cli.debug);
    apply_overrides(&cli);

    let cfg = match launcher::config::try_config() {
        Ok(cfg) => cfg,
        Err(error) => {
            eprintln!("error: {error}");
            exit(2);
        }
    };
    let rootfs = launcher::rootfs::Rootfs::from_config(cfg);
    let rerouted = launcher::config::is_rerouted();

    if cli.print_config {
        for line in launcher::env::describe(cfg, &rootfs) {
            println!("{line}");
        }
        return;
    }

    let Some(binary) = cli.command.first().cloned() else {
        Cli::command().print_help().ok();
        println!();
        exit(2);
    };

    let pwd = match env::current_dir() {
        Ok(pwd) => pwd,
        Err(error) => {
            eprintln!("error: cannot read working directory: {error}");
            exit(1);
        }
    };
    let session = env::var(launcher::env::SESSION_MARKER).is_ok();
    let explicit_cwd = configured_guest_cwd(
        cli.guest_cwd.as_deref(),
        env::var(launcher::config::env_keys::GUEST_CWD).ok(),
        rerouted,
        session,
    );
    let mut guest_cwd = match launch_cwd(cfg, &rootfs, &pwd, explicit_cwd.as_deref()) {
        Ok(cwd) => cwd,
        Err(error) => {
            eprintln!("error: {error}");
            exit(2);
        }
    };
    let initial_dir = match rootfs.dir_for(&guest_cwd) {
        Ok(dir) => dir,
        Err(error) => {
            eprintln!("error: {error}");
            exit(1);
        }
    };

    let mut all_args: Vec<String> = cli.command.clone();
    if let Some(argv0) = &cfg.argv0 {
        all_args[0] = argv0.clone();
    }

    let mut execution =
        match launcher::resolve::resolve(&binary, &all_args, &guest_cwd, !cli.no_preload) {
            Ok(e) => e,
            Err(err) => {
                eprintln!("error: {err}");
                exit(err.exit_code());
            }
        };

    // A host-native binary must not see a glibc preload: Bionic cannot load
    // it, and the guest path mapping is meaningless for it.
    if cli.no_preload || execution.is_native() {
        execution.preload = None;
    }

    let library_path = if execution.loader.is_none() {
        // A native run needs no loader arguments. A direct loader invocation
        // already carries its translated --library-path in argv.
        Vec::new()
    } else {
        let guest_ld = launcher::env::effective_value(&execution.env_overrides, "LD_LIBRARY_PATH");
        let main_elf = execution
            .main_elf
            .clone()
            .unwrap_or_else(|| execution.original_target.clone());
        launcher::resolve::loader_search_path(
            cfg,
            &rootfs,
            &launcher::resolve::LoaderSearch {
                target: execution.arch,
                execution: execution.execution_arch,
                main_elf: &main_elf,
                rpath: &execution.rpath,
                runpath: &execution.runpath,
                guest_library_path: guest_ld.as_deref(),
                guest_cwd: &guest_cwd,
            },
        )
    };

    let chdir_to = if env::var_os("BIONILUX_CHDIR_TO_BINARY").is_some() {
        let dir = execution.original_target.parent().map(ToOwned::to_owned);
        if let Some(dir) = &dir {
            guest_cwd = rootfs.unmap(&dir.to_string_lossy());
        }
        dir
    } else {
        Some(initial_dir)
    };

    let current_exe = env::current_exe().expect("cannot resolve current executable");
    // Under /system/bin/linker64, /proc/self/exe names the linker: the kernel
    // records the ELF it executed. Children must reroute through the launcher,
    // so the path the caller used wins when it still names this process.
    let launcher_path = match launcher_identity(&current_exe) {
        Ok(path) => path,
        Err(error) => {
            eprintln!("error: {error}");
            exit(1);
        }
    };
    // A shebang script is an argument to its interpreter, not the process
    // executable. Perl's $^X, for example, must name perl rather than prove;
    // otherwise prove starts itself again when it tries to run a test.
    let process_image = execution
        .main_elf
        .as_deref()
        .unwrap_or(&execution.exec_target);
    let target_guest = guest_target(process_image, &rootfs);
    let target_env = launcher::env::build(
        cfg,
        &launcher::env::GuestEnv {
            preload: execution.preload.as_deref().and_then(|p| p.to_str()),
            target_guest: &target_guest,
            launcher: &launcher_path.to_string_lossy(),
            arch: execution.arch,
            guest_cwd: &guest_cwd,
            rootfs_enabled: rootfs.enabled(),
            rerouted,
            overrides: &execution.env_overrides,
        },
    );

    if let Err(e) = launcher::exec::execute(&launcher::exec::ExecSpec {
        exec_target: &execution.exec_target,
        loader: execution.loader.as_deref(),
        argv: &execution.argv,
        env: &target_env,
        chdir_to: chdir_to.as_deref(),
        library_path: &library_path,
    }) {
        eprintln!("error: {e}");
        exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reroute_cli_preserves_argv0_and_hyphen_prefixed_target_after_separator() {
        let cli = Cli::try_parse_from([
            "bionilux",
            "--argv0",
            "-original-name",
            "--",
            "-target",
            "--argv0",
            "target-argument",
        ])
        .unwrap();
        assert_eq!(cli.argv0.as_deref(), Some("-original-name"));
        assert_eq!(cli.command, vec!["-target", "--argv0", "target-argument"]);
    }

    #[test]
    fn a_linker_started_launcher_is_its_own_identity() {
        let tmp = tempfile::tempdir().unwrap();
        let launcher = tmp.path().join("bionilux");
        std::fs::write(&launcher, b"launcher").unwrap();
        let exe = std::path::Path::new("/apex/com.android.runtime/bin/linker64");
        let guest = std::path::PathBuf::from("/bin/bash");
        assert_eq!(
            launcher_identity_from(exe, [launcher.clone(), guest.clone()]),
            Some(launcher.clone())
        );
        assert_eq!(
            launcher_identity_from(exe, [exe.to_path_buf(), launcher.clone()]),
            Some(launcher.clone())
        );
        assert_eq!(launcher_identity_from(exe, [guest]), None);
        assert!(!is_launcher_path(std::path::Path::new("bionilux")));
        std::fs::remove_file(&launcher).unwrap();
        std::fs::create_dir(&launcher).unwrap();
        assert!(!is_launcher_path(&launcher));
    }

    #[test]
    fn a_directly_started_launcher_keeps_its_own_path() {
        let exe = std::path::Path::new("/data/user/0/app/files/backend/bin/bionilux");
        assert_eq!(launcher_identity_from(exe, []), Some(exe.to_path_buf()));
    }

    #[test]
    fn target_flags_remain_target_arguments_without_internal_options() {
        let cli = Cli::try_parse_from(["bionilux", "grep", "-n", "--help"]).unwrap();
        assert_eq!(cli.command, vec!["grep", "-n", "--help"]);
        assert!(!cli.no_preload);
    }

    #[test]
    fn reroute_cli_accepts_empty_original_argv0() {
        let cli = Cli::try_parse_from(["bionilux", "--argv0", "", "--", "/bin/tool"]).unwrap();
        assert_eq!(cli.argv0.as_deref(), Some(""));
    }

    #[test]
    fn explicit_guest_cwd_overrides_inherited_directory_inside_rootfs() {
        let tmp = tempfile::tempdir().unwrap();
        let mut cfg = launcher::config::Config::from_env().unwrap();
        cfg.rootfs = Some(tmp.path().to_path_buf());
        let rootfs = launcher::rootfs::Rootfs::from_config(&cfg);
        let pwd = tmp.path().join("work");
        assert_eq!(launch_cwd(&cfg, &rootfs, &pwd, Some("/")).unwrap(), "/");
        assert_eq!(launch_cwd(&cfg, &rootfs, &pwd, None).unwrap(), "/work");
        assert!(launch_cwd(&cfg, &rootfs, &pwd, Some("relative")).is_err());
    }

    #[test]
    fn inherited_guest_cwd_is_only_configuration_for_the_first_entry() {
        let inherited = || Some("/old/session".to_string());
        // The first entry may be configured by the host environment.
        assert_eq!(
            configured_guest_cwd(None, inherited(), false, false).as_deref(),
            Some("/old/session")
        );
        // Inside a running session the physical directory decides instead.
        assert_eq!(configured_guest_cwd(None, inherited(), false, true), None);
        assert_eq!(configured_guest_cwd(None, inherited(), true, false), None);
        // An explicit flag wins in every case.
        assert_eq!(
            configured_guest_cwd(Some("/work"), inherited(), true, true).as_deref(),
            Some("/work")
        );
        assert_eq!(
            configured_guest_cwd(None, Some(String::new()), false, false),
            None
        );
    }

    #[test]
    fn guest_target_reports_the_resolved_entry_point() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("rootfs");
        std::fs::create_dir_all(root.join("opt/sdk/bin")).unwrap();
        std::fs::create_dir_all(root.join("usr/local/bin")).unwrap();
        std::fs::write(root.join("opt/sdk/bin/tool"), b"x").unwrap();
        // Relative link, as prepare-rootfs leaves them.
        std::os::unix::fs::symlink("../../../opt/sdk/bin/tool", root.join("usr/local/bin/tool"))
            .unwrap();

        let mut cfg = launcher::config::Config::from_env().unwrap();
        cfg.rootfs = Some(root.clone());
        let rootfs = launcher::rootfs::Rootfs::from_config(&cfg);
        assert_eq!(
            guest_target(&root.join("usr/local/bin/tool"), &rootfs),
            "/opt/sdk/bin/tool"
        );

        // A link that leaves the rootfs keeps the name the guest used, so no
        // host path can be reported.
        std::os::unix::fs::symlink("/etc/hostname", root.join("usr/local/bin/escape")).unwrap();
        assert_eq!(
            guest_target(&root.join("usr/local/bin/escape"), &rootfs),
            "/usr/local/bin/escape"
        );
    }
}
