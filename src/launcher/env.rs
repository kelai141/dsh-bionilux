use std::collections::HashMap;
use std::env;
use std::path::Path;

const BIONIC_PRELOAD_BLOCKLIST: &[&str] = &["libtermux-exec"];

const TERMUX_CA_FILE: &str = "/data/data/com.termux/files/usr/etc/tls/cert.pem";
const TERMUX_CA_DIR: &str = "/data/data/com.termux/files/usr/etc/tls/certs";

fn filter_preload(entry_list: &str) -> Vec<String> {
    entry_list
        .split(':')
        .filter(|e| !e.is_empty())
        .filter(|e| !BIONIC_PRELOAD_BLOCKLIST.iter().any(|bad| e.contains(bad)))
        .map(String::from)
        .collect()
}

fn setup_tls(vars: &mut HashMap<String, String>) {
    if !vars.contains_key("SSL_CERT_FILE") && Path::new(TERMUX_CA_FILE).exists() {
        vars.insert("SSL_CERT_FILE".into(), TERMUX_CA_FILE.into());
    }
    if !vars.contains_key("SSL_CERT_DIR") && Path::new(TERMUX_CA_DIR).exists() {
        vars.insert("SSL_CERT_DIR".into(), TERMUX_CA_DIR.into());
    }
}

pub fn build_target_env(
    preload: Option<&str>,
    target: &Path,
    launcher: &Path,
    is_x86_64: bool,
) -> Vec<String> {
    let mut vars: HashMap<String, String> = env::vars().collect();

    vars.remove("BIONILUX_TARGET_EXE");
    vars.remove("BIONILUX_BINARY_PATH");
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

            setup_tls(&mut vars);
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
