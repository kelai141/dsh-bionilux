use std::sync::atomic::{AtomicBool, Ordering};

static ENABLED: AtomicBool = AtomicBool::new(false);

// Called once from main with the --debug flag. Empty BIONILUX_DEBUG= disables.
pub fn init(force: bool) {
    let from_env = std::env::var_os("BIONILUX_DEBUG")
        .map(|v| !v.is_empty())
        .unwrap_or(false);
    ENABLED.store(force || from_env, Ordering::Relaxed);
}

pub fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

#[macro_export]
macro_rules! debug {
    ($($arg:tt)*) => {
        if $crate::debug::enabled() {
            eprintln!("[DEBUG] {}", format_args!($($arg)*));
        }
    };
}
