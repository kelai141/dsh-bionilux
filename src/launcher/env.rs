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
    env_keys::INTERNAL_ARGV0,
];

/// Remove a Termux-era preload entry that cannot be loaded by a glibc process.
fn filter_preload(entry_list: &str) -> Vec<String> {
    entry_list
        .split(|ch: char| ch == ':' || ch.is_ascii_whitespace())
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
    pub rerouted: bool,
    pub overrides: &'a [(String, String)],
}

/// Build the guest environment as `KEY=VALUE` entries.
pub fn build(cfg: &Config, spec: &GuestEnv<'_>) -> Vec<String> {
    build_from(cfg, spec, env::vars().collect())
}

fn build_from(cfg: &Config, spec: &GuestEnv<'_>, mut vars: HashMap<String, String>) -> Vec<String> {
    let existing_preload = vars
        .remove(env_keys::INTERNAL_PRELOAD)
        .or_else(|| vars.get("LD_PRELOAD").cloned())
        .unwrap_or_default();
    for key in ALWAYS_DROP.iter().chain(config::host_env_leaks()) {
        vars.remove(*key);
    }

    if spec.rootfs_enabled && !spec.rerouted {
        vars.insert("PATH".into(), cfg.guest_path.join(":"));
        vars.insert("HOME".into(), cfg.guest_home.clone());
        vars.insert("TMPDIR".into(), cfg.guest_tmp.clone());
        vars.insert("TMP".into(), cfg.guest_tmp.clone());
        vars.entry("LANG".into())
            .or_insert_with(|| "C.UTF-8".into());
        vars.insert("SHELL".into(), "/bin/sh".into());
        if cfg.fake_root {
            vars.insert("USER".into(), "root".into());
            vars.insert("LOGNAME".into(), "root".into());
        }
    }

    vars.insert("PWD".into(), spec.guest_cwd.to_string());

    match spec.preload {
        Some(p) => {
            let rootfs = Rootfs::from_config(cfg);
            let mut merged = vec![p.to_string()];
            for entry in filter_preload(&existing_preload) {
                if entry == p {
                    continue;
                }
                let entry = if spec.rootfs_enabled && entry.starts_with('/') {
                    rootfs.physical(&entry).to_string_lossy().into_owned()
                } else {
                    entry
                };
                if !merged.contains(&entry) {
                    merged.push(entry);
                }
            }

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
    for (key, path) in [
        (env_keys::PRELOAD, cfg.preload.as_ref()),
        (env_keys::LOADER, cfg.loader.as_ref()),
    ] {
        match path {
            Some(path) => vars.insert(key.into(), path.to_string_lossy().into_owned()),
            None => vars.remove(key),
        };
    }
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

    configure_box64(&mut vars, cfg, spec.arch, Arch::host());

    for (k, v) in spec.overrides {
        vars.insert(k.clone(), v.clone());
    }
    vars.remove(env_keys::INTERNAL_PRELOAD);
    vars.remove(env_keys::INTERNAL_ARGV0);
    if spec.preload.is_none() {
        vars.remove("LD_PRELOAD");
    }

    vars.into_iter().map(|(k, v)| format!("{k}={v}")).collect()
}

fn configure_box64(vars: &mut HashMap<String, String>, cfg: &Config, target: Arch, host: Arch) {
    if target == Arch::X86_64 && host == Arch::Aarch64 {
        vars.insert("BOX64_UNAME".into(), "x86_64".into());
        let guest_libraries = crate::launcher::resolve::library_path(cfg, target);
        if !guest_libraries.is_empty() {
            vars.entry("BOX64_LD_LIBRARY_PATH".into())
                .or_insert_with(|| guest_libraries.join(":"));
        }
    } else {
        vars.remove("BOX64_UNAME");
    }
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

    fn guest_spec<'a>(rerouted: bool) -> GuestEnv<'a> {
        GuestEnv {
            preload: Some("/runtime/preload.so"),
            target_guest: "/bin/tool",
            launcher: "/runtime/bionilux",
            arch: Arch::host(),
            guest_cwd: "/work",
            rootfs_enabled: true,
            rerouted,
            overrides: &[],
        }
    }

    fn environment(entries: &[(&str, &str)]) -> HashMap<String, String> {
        entries
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn unpack(entries: Vec<String>) -> HashMap<String, String> {
        entries
            .into_iter()
            .map(|entry| {
                let (key, value) = entry.split_once('=').unwrap();
                (key.to_string(), value.to_string())
            })
            .collect()
    }

    #[test]
    fn rerouted_children_keep_guest_environment_changes() {
        let cfg = Config::from_env().unwrap();
        let expected = environment(&[
            ("PATH", "/work/venv/bin:/custom/bin"),
            ("HOME", "/work/home"),
            ("TMPDIR", "/work/temp"),
            ("TMP", "/work/other-temp"),
            ("SHELL", "/bin/bash"),
            ("MAKEFLAGS", " -j8 --jobserver-auth=3,4"),
        ]);
        let actual = unpack(build_from(&cfg, &guest_spec(true), expected.clone()));
        for (key, value) in expected {
            assert_eq!(actual.get(&key), Some(&value), "{key}");
        }
        assert_eq!(actual["PWD"], "/work");
    }

    #[test]
    fn rerouted_children_preserve_unset_and_empty_variables() {
        let cfg = Config::from_env().unwrap();
        let vars = unpack(build_from(
            &cfg,
            &guest_spec(true),
            environment(&[("PATH", "")]),
        ));
        assert_eq!(vars["PATH"], "");
        for key in ["HOME", "TMPDIR", "TMP", "SHELL"] {
            assert!(!vars.contains_key(key), "{key}");
        }
    }

    #[test]
    fn initial_entry_replaces_host_paths_and_removes_internal_argv0() {
        let cfg = Config::from_env().unwrap();
        let actual = unpack(build_from(
            &cfg,
            &guest_spec(false),
            environment(&[
                ("PATH", "/host/bin"),
                ("HOME", "/host/home"),
                ("TMPDIR", "/host/tmp"),
                ("SHELL", "/host/bin/sh"),
                (env_keys::INTERNAL_ARGV0, "one-invocation-only"),
            ]),
        ));
        assert_eq!(actual["PATH"], cfg.guest_path.join(":"));
        assert_eq!(actual["HOME"], cfg.guest_home);
        assert_eq!(actual["TMPDIR"], cfg.guest_tmp);
        assert_eq!(actual["SHELL"], "/bin/sh");
        assert!(!actual.contains_key(env_keys::INTERNAL_ARGV0));
    }

    #[test]
    fn rerouted_guest_preloads_are_mapped_preserved_and_runtime_is_deduplicated() {
        let tmp = tempfile::tempdir().unwrap();
        let mut cfg = Config::from_env().unwrap();
        cfg.rootfs = Some(tmp.path().to_path_buf());
        cfg.lenient = false;
        cfg.host_paths.clear();
        let runtime = tmp
            .path()
            .join("usr/lib/libbionilux_preload.so")
            .display()
            .to_string();
        let mut spec = guest_spec(true);
        spec.preload = Some(&runtime);
        let incoming = format!(
            "{runtime}:/opt/extra.so /opt/extra.so:libextra.so:/usr/lib/libbionilux_preload.so"
        );
        let vars = unpack(build_from(
            &cfg,
            &spec,
            environment(&[
                (env_keys::INTERNAL_PRELOAD, &incoming),
                ("LD_PRELOAD", "must-not-win-over-carrier.so"),
            ]),
        ));
        assert_eq!(
            vars["LD_PRELOAD"],
            format!(
                "{runtime}:{}:libextra.so",
                tmp.path().join("opt/extra.so").display()
            )
        );
        assert!(!vars.contains_key(env_keys::INTERNAL_PRELOAD));
        assert!(!vars.contains_key(env_keys::INTERNAL_ARGV0));
    }

    #[test]
    fn native_environment_drops_preloads_and_internal_transport_state() {
        let cfg = Config::from_env().unwrap();
        let mut spec = guest_spec(true);
        spec.preload = None;
        let overrides = [("LD_PRELOAD".into(), "must-not-reach-bionic.so".into())];
        spec.overrides = &overrides;
        let vars = unpack(build_from(
            &cfg,
            &spec,
            environment(&[
                (env_keys::INTERNAL_PRELOAD, "arbitrary-guest.so"),
                (env_keys::INTERNAL_ARGV0, "internal-name"),
                ("LD_PRELOAD", "another-guest.so"),
            ]),
        ));
        for key in [
            "LD_PRELOAD",
            env_keys::INTERNAL_PRELOAD,
            env_keys::INTERNAL_ARGV0,
        ] {
            assert!(!vars.contains_key(key), "{key}");
        }
    }

    #[test]
    fn child_identity_exports_anchored_loader_and_preload_paths() {
        let mut cfg = Config::from_env().unwrap();
        cfg.preload = Some("/anchored/runtime/preload.so".into());
        cfg.loader = Some("/anchored/runtime/loader".into());
        let vars = unpack(build_from(
            &cfg,
            &guest_spec(true),
            environment(&[
                (env_keys::PRELOAD, "relative/preload.so"),
                (env_keys::LOADER, "relative/loader"),
            ]),
        ));
        assert_eq!(vars[env_keys::PRELOAD], "/anchored/runtime/preload.so");
        assert_eq!(vars[env_keys::LOADER], "/anchored/runtime/loader");
    }

    #[test]
    fn whitespace_preload_lists_filter_only_the_bionic_entry() {
        assert_eq!(
            filter_preload("/bionic/libtermux-exec.so /guest/keep.so:libextra.so"),
            vec!["/guest/keep.so", "libextra.so"]
        );
    }

    #[test]
    fn box64_environment_separates_guest_library_paths_and_preserves_user_values() {
        let tmp = tempfile::tempdir().unwrap();
        let mut cfg = Config::from_env().unwrap();
        cfg.rootfs = Some(tmp.path().to_path_buf());
        std::fs::create_dir_all(tmp.path().join("lib/x86_64-linux-gnu")).unwrap();
        let mut vars = HashMap::new();
        configure_box64(&mut vars, &cfg, Arch::X86_64, Arch::Aarch64);
        assert_eq!(vars["BOX64_UNAME"], "x86_64");
        assert_eq!(
            vars["BOX64_LD_LIBRARY_PATH"],
            crate::launcher::resolve::library_path(&cfg, Arch::X86_64).join(":")
        );
        vars.insert("BOX64_LD_LIBRARY_PATH".into(), "/custom/x86/libs".into());
        vars.insert("BOX64_LD_PRELOAD".into(), "custom-x86-preload.so".into());
        configure_box64(&mut vars, &cfg, Arch::X86_64, Arch::Aarch64);
        assert_eq!(vars["BOX64_LD_LIBRARY_PATH"], "/custom/x86/libs");
        assert_eq!(vars["BOX64_LD_PRELOAD"], "custom-x86-preload.so");
    }

    #[test]
    fn host_leaks_include_termux_prefix() {
        // PREFIX must never reach a guest: programs would use it to find
        // Termux' user space.
        assert!(config::host_env_leaks().contains(&"PREFIX"));
    }
}
