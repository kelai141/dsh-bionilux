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
    rerouted: bool,
) -> Result<String, String> {
    if let Some(cwd) = explicit {
        if !cwd.starts_with('/') {
            return Err(format!("guest working directory must be absolute: {cwd}"));
        }
        Ok(launcher::config::normalize(cwd))
    } else {
        Ok(launcher::resolve::guest_cwd_for(cfg, rootfs, pwd, rerouted))
    }
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
    let explicit_cwd = cli.guest_cwd.clone().or_else(|| {
        (!rerouted)
            .then(|| env::var(launcher::config::env_keys::GUEST_CWD).ok())
            .flatten()
            .filter(|cwd| !cwd.is_empty())
    });
    let mut guest_cwd = match launch_cwd(cfg, &rootfs, &pwd, explicit_cwd.as_deref(), rerouted) {
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

    let library_path = if execution.is_native() {
        Vec::new()
    } else {
        launcher::resolve::execution_library_path(cfg, execution.arch, execution.execution_arch)
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
    let target_guest = rootfs.unmap(&execution.original_target.to_string_lossy());
    let target_env = launcher::env::build(
        cfg,
        &launcher::env::GuestEnv {
            preload: execution.preload.as_deref().and_then(|p| p.to_str()),
            target_guest: &target_guest,
            launcher: &current_exe.to_string_lossy(),
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
        assert_eq!(
            launch_cwd(&cfg, &rootfs, &pwd, Some("/"), true).unwrap(),
            "/"
        );
        assert_eq!(
            launch_cwd(&cfg, &rootfs, &pwd, None, true).unwrap(),
            "/work"
        );
        assert!(launch_cwd(&cfg, &rootfs, &pwd, Some("relative"), false).is_err());
    }
}
