use clap::Parser;
use std::env;
use std::process::exit;

mod analyzer;
mod debug;
mod launcher;

#[derive(Parser, Debug)]
#[command(
    name = "bionilux",
    version,
    about = "Run glibc and x86_64 Linux binaries on Termux",
    disable_help_subcommand = true,
    arg_required_else_help = true,
    after_help = "Examples:\n  \
        bionilux ./my_binary                    # glibc or x86_64, auto-detected\n  \
        bionilux $PREFIX/glibc/bin/bash         # glibc shell\n  \
        BIONILUX_DEBUG=1 bionilux ./my_app      # verbose\n  \
        bionilux -n ./static_glibc_binary       # skip preload injection\n  \
        bionilux ls -la                         # pass args through"
)]
struct Cli {
    /// Print debug output to stderr
    #[arg(short, long)]
    debug: bool,

    /// Skip LD_PRELOAD injection (no child rerouting)
    #[arg(short = 'n', long = "no-preload")]
    no_preload: bool,

    /// Target binary to run
    binary: String,

    /// Arguments passed to the target binary
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    args: Vec<String>,
}

fn main() {
    let cli = Cli::parse();
    debug::init(cli.debug);

    let mut all_args = vec![cli.binary.clone()];
    all_args.extend(cli.args.iter().cloned());

    let mut execution = match launcher::resolve::resolve(&cli.binary, &all_args) {
        Ok(e) => e,
        Err(err) => {
            eprintln!("error: {err}");
            exit(err.exit_code());
        }
    };

    if cli.no_preload {
        execution.preload = None;
    }

    let chdir_to = if env::var_os("BIONILUX_CHDIR_TO_BINARY").is_some() {
        execution.original_target.parent()
    } else {
        None
    };

    let current_exe = env::current_exe().expect("cannot resolve current executable");
    let target_env = launcher::env::build_target_env(
        execution.preload.as_deref().and_then(|p| p.to_str()),
        &execution.exec_target,
        &current_exe,
        execution.is_x86_64,
    );

    launcher::exec::execute(
        &execution.exec_target,
        execution.loader.as_deref(),
        &execution.argv,
        &target_env,
        chdir_to,
    );
}
