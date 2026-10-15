//! Guest environment construction.
//!
//! Two rules drive everything here:
//!
//! 1. The guest must not be able to tell it is running inside an Android app.
//!    Host variables that point into the host user space (`PREFIX`, Termux
//!    metadata) are removed rather than inherited.
//! 2. Anything the guest can legitimately set itself (`LD_LIBRARY_PATH`, user
//!    `LD_PRELOAD` entries) is preserved. The loader's own search path is
//!    supplied per-invocation on the command line, not through the
//!    environment, so guest intentions survive.

use std::collections::HashMap;
use std::env;

use crate::launcher::config::{self, Arch, Config, env_keys};
use crate::launcher::rootfs::Rootfs;

const BIONIC_PRELOAD_BLOCKLIST: &[&str] = &["libtermux-exec"];

/// Variables that are always dropped: they either ask the loader to do
/// something that cannot work across a libc boundary, or they would be
/// re-derived incorrectly for the guest.
const ALWAYS_DROP: &[&str] = &[
    "LD_AUDIT",
    "LD_DEBUG",
    "LD_PROFILE",
    // Rebuilt below; an inherited value could point anywhere.
    env_keys::TARGET_EXE,
    env_keys::BINARY_PATH,
];

/// Remove a Termux-era preload entry that cannot be loaded by a glibc process.
fn filter_preload(entry_list: &str) -> Vec<String> {
    entry_list
        .split(':')
        .filter(|e| !e.is_empty())
        .filter(|e| !BIONIC_PRELOAD_BLOCKLIST.iter().any(|bad| e.contains(bad)))
        .map(String::from)
        .collect()
}

/// Everything the guest needs to know about the runtime it is running in.
pub struct GuestEnv<'a> {
    pub preload: Option<&'a str>,
    /// Guest-visible path of the program, reported by `/proc/self/exe`.
    pub target_guest: &'a str,
    /// Physical path of the launcher, so children can be rerouted.
    pub launcher: &'a str,
    pub arch: Arch,
    pub guest_cwd: &'a str,
    pub rootfs_enabled: bool,
    pub overrides: &'a [(String, String)],
}

/// Build the guest environment as `KEY=VALUE` entries.
pub fn build(cfg: &Config, spec: &GuestEnv<'_>) -> Vec<String> {
    let mut vars: HashMap<String, String> = env::vars().collect();

    for key in ALWAYS_DROP.iter().chain(config::host_env_leaks()) {
        vars.remove(*key);
    }

    if spec.rootfs_enabled {
        vars.insert("PATH".into(), cfg.guest_path.join(":"));
        vars.insert("HOME".into(), cfg.guest_home.clone());
        vars.insert("TMPDIR".into(), cfg.guest_tmp.clone());
        vars.insert("TMP".into(), cfg.guest_tmp.clone());
        vars.entry("LANG".into())
            .or_insert_with(|| "C.UTF-8".into());
        vars.entry("SHELL".into())
            .or_insert_with(|| "/bin/sh".into());
        if cfg.fake_root {
            vars.insert("USER".into(), "root".into());
            vars.insert("LOGNAME".into(), "root".into());
        }
    }

    vars.insert("PWD".into(), spec.guest_cwd.to_string());

    match spec.preload {
        Some(p) => {
            let existing = vars.get("LD_PRELOAD").cloned().unwrap_or_default();
            let mut merged = filter_preload(&existing);
            merged.insert(0, p.to_string());

            vars.insert("LD_PRELOAD".into(), merged.join(":"));
            vars.insert(env_keys::TARGET_EXE.into(), spec.target_guest.to_string());
            vars.insert(env_keys::BINARY_PATH.into(), spec.launcher.to_string());
        }
        None => {
            vars.remove("LD_PRELOAD");
            vars.remove(env_keys::BINARY_PATH);
            vars.remove(env_keys::TARGET_EXE);
        }
    }

    // Runtime identity, so a rerouted child derives the same mapping.
    vars.insert(env_keys::GUEST_PATH.into(), cfg.guest_path.join(":"));
    vars.insert(env_keys::GUEST_HOME.into(), cfg.guest_home.clone());
    vars.insert(env_keys::GUEST_TMP.into(), cfg.guest_tmp.clone());
    vars.insert(env_keys::GUEST_CWD.into(), spec.guest_cwd.to_string());
    match &cfg.rootfs {
        Some(root) => vars.insert(env_keys::ROOTFS.into(), root.to_string_lossy().into_owned()),
        None => vars.remove(env_keys::ROOTFS),
    };
    match &cfg.prefix {
        Some(prefix) => vars.insert(
            env_keys::PREFIX.into(),
            prefix.to_string_lossy().into_owned(),
        ),
        None => vars.remove(env_keys::PREFIX),
    };
    match &cfg.runtime_dir {
        Some(rt) => vars.insert(
            env_keys::RUNTIME_DIR.into(),
            rt.to_string_lossy().into_owned(),
        ),
        None => vars.remove(env_keys::RUNTIME_DIR),
    };
    match &cfg.box64 {
        Some(b) => vars.insert(env_keys::BOX64.into(), b.to_string_lossy().into_owned()),
        None => vars.remove(env_keys::BOX64),
    };
    vars.insert(
        env_keys::FAKE_ROOT.into(),
        if cfg.fake_root { "1" } else { "0" }.into(),
    );
    vars.insert(
        env_keys::LENIENT.into(),
        if cfg.lenient { "1" } else { "0" }.into(),
    );
    // The preload hook needs the same host-path list to decide what to leave
    // alone; it has no access to the launcher's configuration object.
    vars.insert(
        env_keys::HOST_PATHS.into(),
        cfg.host_paths
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(":"),
    );

    if spec.arch != Arch::host() {
        vars.insert("BOX64_UNAME".into(), "x86_64".into());
    } else {
        vars.remove("BOX64_UNAME");
    }

    for (k, v) in spec.overrides {
        vars.insert(k.clone(), v.clone());
    }

    vars.into_iter().map(|(k, v)| format!("{k}={v}")).collect()
}

/// Explicit `--print-config` output, for health checks and the DSH plugin.
pub fn describe(cfg: &Config, rootfs: &Rootfs) -> Vec<String> {
    let mut out = Vec::new();
    let mut push = |k: &str, v: String| out.push(format!("{k}={v}"));

    push("BIONILUX_VERSION", env!("CARGO_PKG_VERSION").to_string());
    push("HOST_ARCH", format!("{:?}", Arch::host()));
    push("HOST_TRIPLET", Arch::host().triplet().to_string());
    push(
        "ROOTFS",
        cfg.rootfs
            .as_ref()
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
    );
    push(
        "ROOTFS_ENABLED",
        if rootfs.enabled() { "1" } else { "0" }.into(),
    );
    let has_loader = crate::launcher::resolve::find_loader(
        &format!("/lib/{}", Arch::host().loader_name()),
        Arch::host(),
    )
    .is_some();
    push(
        "ROOTFS_LOADER",
        if has_loader { "yes" } else { "no" }.into(),
    );
    push("GUEST_PATH", cfg.guest_path.join(":"));
    push("GUEST_HOME", cfg.guest_home.clone());
    push("GUEST_TMP", cfg.guest_tmp.clone());
    push("GUEST_CWD", cfg.guest_cwd.clone());
    push("FAKE_ROOT", if cfg.fake_root { "1" } else { "0" }.into());
    push("LENIENT", if cfg.lenient { "1" } else { "0" }.into());
    push(
        "HOST_PATHS",
        cfg.host_paths
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(":"),
    );
    push(
        "PREFIX",
        cfg.prefix
            .as_ref()
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
    );
    push(
        "RUNTIME_DIR",
        cfg.runtime_dir
            .as_ref()
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
    );

    // Health check: the guest must be able to run a shell and reach apt.
    if let Some(root) = &cfg.rootfs {
        for probe in [
            "bin/sh",
            "usr/bin/apt-get",
            "usr/bin/dpkg",
            "etc/os-release",
        ] {
            let present = root.join(probe).exists();
            push(
                &format!("PRESENT_{}", probe.to_uppercase().replace(['/', '.'], "_")),
                if present { "yes" } else { "no" }.into(),
            );
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filter_preload_drops_termux_exec() {
        let got = filter_preload(&format!(
            "/a/libtermux-exec.so:/b/other.so:{}",
            "/c/libtermux-exec-ld.so"
        ));
        assert_eq!(got, vec!["/b/other.so"]);
    }

    #[test]
    fn filter_preload_keeps_everything_else() {
        assert_eq!(filter_preload("/x.so::/y.so"), vec!["/x.so", "/y.so"]);
        assert!(filter_preload("").is_empty());
    }

    #[test]
    fn host_leaks_include_termux_prefix() {
        // PREFIX must never reach a guest: programs would use it to find
        // Termux' user space.
        assert!(config::host_env_leaks().contains(&"PREFIX"));
    }
}
