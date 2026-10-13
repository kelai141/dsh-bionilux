use std::collections::HashMap;
use std::env;
use std::path::Path;

// Bionic-only preload entries that must not be forwarded into a glibc
// process. Termux sets LD_PRELOAD to libtermux-exec-ld-preload.so by
// default; the glibc loader rejects it with a version error.
const BIONIC_PRELOAD_BLOCKLIST: &[&str] = &["libtermux-exec"];

fn filter_preload(entry_list: &str) -> Vec<String> {
    entry_list
        .split(':')
        .filter(|e| !e.is_empty())
        .filter(|e| !BIONIC_PRELOAD_BLOCKLIST.iter().any(|bad| e.contains(bad)))
        .map(String::from)
        .collect()
}

// Never set LD_PRELOAD="" — box64 crashes on empty values (strlen(NULL)).
pub fn build_target_env(
    preload: Option<&str>,
    target: &Path,
    launcher: &Path,
    is_x86_64: bool,
) -> Vec<String> {
    let mut vars: HashMap<String, String> = env::vars().collect();

    vars.remove("BIONILUX_TARGET_EXE");
    vars.remove("BIONILUX_BINARY_PATH");

    // glibc-specific debugging hooks must not leak into bionic land,
    // and bionic hooks must not leak into glibc land.
    vars.remove("LD_AUDIT");
    vars.remove("LD_DEBUG");

    match preload {
        Some(p) => {
            let existing = vars.get("LD_PRELOAD").cloned().unwrap_or_default();
            let mut merged = filter_preload(&existing);
            merged.insert(0, p.to_string());

            vars.insert("LD_PRELOAD".into(), merged.join(":"));
            vars.insert("BIONILUX_TARGET_EXE".into(), target.display().to_string());
            vars.insert(
                "BIONILUX_BINARY_PATH".into(),
                launcher.display().to_string(),
            );
        }
        None => {
            vars.remove("LD_PRELOAD");
        }
    }

    if is_x86_64 {
        vars.insert("BOX64_UNAME".into(), "x86_64".into());
    } else {
        vars.remove("BOX64_UNAME");
    }

    vars.into_iter().map(|(k, v)| format!("{k}={v}")).collect()
}
