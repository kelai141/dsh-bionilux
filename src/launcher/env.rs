use std::collections::HashMap;
use std::env;
use std::path::Path;

// Never set LD_PRELOAD="" — box64 crashes on empty values (strlen(NULL)).
pub fn build_target_env(
    preload: Option<&str>,
    target: &Path,
    launcher: &Path,
    is_x86_64: bool,
) -> Vec<String> {
    let mut vars: HashMap<String, String> = env::vars().collect();

    // Drop stale vars inherited from a parent bionilux context.
    vars.remove("BIONILUX_TARGET_EXE");
    vars.remove("BIONILUX_BINARY_PATH");

    match preload {
        Some(p) => {
            let merged = match vars.get("LD_PRELOAD") {
                Some(old) if !old.is_empty() => format!("{p}:{old}"),
                _ => p.to_string(),
            };
            vars.insert("LD_PRELOAD".into(), merged);
            vars.insert("BIONILUX_TARGET_EXE".into(), target.display().to_string());
            vars.insert("BIONILUX_BINARY_PATH".into(), launcher.display().to_string());
        }
        None => {
            vars.remove("LD_PRELOAD");
        }
    }

    // Box64 fakes uname -m for x86_64 targets. An aarch64 child must not
    // inherit it — strip on the else branch.
    if is_x86_64 {
        vars.insert("BOX64_UNAME".into(), "x86_64".into());
    } else {
        vars.remove("BOX64_UNAME");
    }

    vars.into_iter().map(|(k, v)| format!("{k}={v}")).collect()
}