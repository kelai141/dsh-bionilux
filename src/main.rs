use std::env;
use std::process::exit;

mod analyzer;
mod debug;
mod launcher;

fn print_usage() {
    eprintln!("Usage: bionilux <binary> [args...]");
    eprintln!();
    eprintln!("Runs glibc-linked Linux binaries on Termux (Bionic libc).");
    eprintln!("x86_64 binaries are routed through Box64.");
    eprintln!();
    eprintln!("Env:  BIONILUX_DEBUG=1             verbose output");
    eprintln!("      BIONILUX_CHDIR_TO_BINARY=1  chdir to the target's directory");
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        print_usage();
        exit(1);
    }

    let execution = match launcher::resolve::resolve(&args[1], &args[1..]) {
        Ok(e) => e,
        Err(err) => {
            eprintln!("[ERROR] {err}");
            exit(err.exit_code());
        }
    };

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
