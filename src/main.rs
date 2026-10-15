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

    /// Print the resolved runtime identity and exit
    #[arg(long = "print-config")]
    print_config: bool,

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
    ];
    for (key, value) in pairs {
        if let Some(value) = value {
            // SAFETY: called before any thread is spawned and before the
            // configuration cache is initialized.
            unsafe { env::set_var(key, value) };
        }
    }
}

fn main() {
    let cli = Cli::parse();
    debug::init(cli.debug);
    apply_overrides(&cli);

    let cfg = launcher::config::config();
    let rootfs = launcher::rootfs::Rootfs::from_config(cfg);

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

    let pwd = env::current_dir().unwrap_or_else(|_| "/".into());
    let guest_cwd = launcher::resolve::guest_cwd_for(cfg, &rootfs, &pwd);

    let all_args: Vec<String> = cli.command.clone();

    let mut execution = match launcher::resolve::resolve(&binary, &all_args, &guest_cwd) {
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
        launcher::resolve::library_path(cfg, execution.arch)
    };

    let chdir_to = if env::var_os("BIONILUX_CHDIR_TO_BINARY").is_some() {
        execution.original_target.parent().map(ToOwned::to_owned)
    } else if rootfs.enabled() && !rootfs.contains(&pwd) {
        Some(rootfs.dir_for(&guest_cwd))
    } else {
        None
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
