use std::sync::OnceLock;

static ENABLED: OnceLock<bool> = OnceLock::new();

// Empty BIONILUX_DEBUG= disables debug output.
pub fn enabled() -> bool {
    *ENABLED.get_or_init(|| {
        std::env::var_os("BIONILUX_DEBUG")
            .map(|v| !v.is_empty())
            .unwrap_or(false)
    })
}

#[macro_export]
macro_rules! debug {
    ($($arg:tt)*) => {
        if $crate::debug::enabled() {
            eprintln!("[DEBUG] {}", format_args!($($arg)*));
        }
    };
}