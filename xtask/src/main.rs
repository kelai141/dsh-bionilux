//! 构建编排：launcher、glibc preload、backend 目录与 APK loader。
//!
//! 这里不是发布流水线的重写：tar.xz 打包、`linux-release.json` 与校验和仍由 CI 的
//! `scripts/build_release_manifest.py` 负责。

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

#[derive(Clone)]
struct Abi {
    name: &'static str,
    rust_target: &'static str,
    ndk_triple: &'static str,
    preload_cc: &'static str,
    preload_rpath: &'static str,
    debian_loader: &'static str,
    jni_abi: &'static str,
}

const ABIS: &[Abi] = &[
    Abi {
        name: "aarch64",
        rust_target: "aarch64-linux-android",
        ndk_triple: "aarch64-linux-android",
        preload_cc: "aarch64-linux-gnu-gcc",
        preload_rpath: "/usr/lib/aarch64-linux-gnu",
        debian_loader: "/lib/ld-linux-aarch64.so.1",
        jni_abi: "arm64-v8a",
    },
    Abi {
        name: "x86_64",
        rust_target: "x86_64-linux-android",
        ndk_triple: "x86_64-linux-android",
        preload_cc: "gcc",
        preload_rpath: "/usr/lib/x86_64-linux-gnu",
        debian_loader: "/lib64/ld-linux-x86-64.so.2",
        jni_abi: "x86_64",
    },
];

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("xtask: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().skip(1).collect();
    let (command, rest) = args.split_first().ok_or_else(usage)?;
    match command.as_str() {
        "build" => {
            let abi = abi_arg(rest)?;
            build(&abi, !rest.iter().any(|a| a == "--debug"))
        }
        "backend" => backend(&abi_arg(rest)?),
        "loader" => {
            let abi = abi_arg(rest)?;
            let rootfs = value_arg(rest, "--rootfs")?;
            let out = value_arg(rest, "--out").unwrap_or_else(|_| ".bionilux-loader".into());
            loader(&abi, Path::new(&rootfs), Path::new(&out))
        }
        "all" => {
            let abi = abi_arg(rest)?;
            build(&abi, true)?;
            backend(&abi)
        }
        "help" | "--help" | "-h" => {
            println!("{}", usage());
            Ok(())
        }
        other => Err(format!("unknown command `{other}`\n\n{}", usage())),
    }
}

fn usage() -> String {
    "usage:\n  cargo xtask build   --abi <aarch64|x86_64> [--debug]\n  cargo xtask backend --abi <aarch64|x86_64>\n  cargo xtask loader  --abi <aarch64|x86_64> --rootfs <dir> [--out <dir>]\n  cargo xtask all     --abi <aarch64|x86_64>".into()
}

fn abi_arg(args: &[String]) -> Result<Abi, String> {
    let name = value_arg(args, "--abi")?;
    ABIS.iter()
        .find(|abi| abi.name == name)
        .cloned()
        .ok_or_else(|| format!("unknown ABI `{name}`"))
}

fn value_arg(args: &[String], key: &str) -> Result<String, String> {
    args.iter()
        .position(|arg| arg == key)
        .and_then(|index| args.get(index + 1))
        .cloned()
        .ok_or_else(|| format!("missing {key}"))
}

fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("xtask lives under the workspace root")
        .to_path_buf()
}

fn build(abi: &Abi, release: bool) -> Result<(), String> {
    let root = workspace_root();
    let ndk = ndk_path()?;
    let toolchain = ndk.join("toolchains/llvm/prebuilt").join(ndk_host_tag());
    let linker = toolchain
        .join("bin")
        .join(format!("{}24-clang", abi.ndk_triple));
    if !linker.is_file() {
        return Err(format!("NDK linker not found: {}", linker.display()));
    }

    let target_key = abi.rust_target.replace('-', "_");
    let target_upper = target_key.to_uppercase();
    let mut rustflags = env::var("RUSTFLAGS").unwrap_or_default();
    rustflags.push_str(" -C link-arg=-Wl,-z,max-page-size=16384");

    let mut cargo = Command::new(env::var("CARGO").unwrap_or_else(|_| "cargo".into()));
    cargo
        .current_dir(&root)
        .args([
            "build",
            "--locked",
            "--package",
            "bionilux",
            "--target",
            abi.rust_target,
        ])
        .env(format!("CARGO_TARGET_{target_upper}_LINKER"), &linker)
        .env(format!("CC_{target_key}"), &linker)
        .env(format!("AR_{target_key}"), toolchain.join("bin/llvm-ar"))
        .env("RUSTFLAGS", rustflags);
    if release {
        cargo.arg("--release");
    }
    run_command(cargo)?;

    let profile = if release { "release" } else { "debug" };
    let stage = root.join("target/release-assets");
    fs::create_dir_all(&stage).map_err(|e| format!("create {}: {e}", stage.display()))?;
    let launcher = root
        .join("target")
        .join(abi.rust_target)
        .join(profile)
        .join("bionilux");
    copy(&launcher, &stage.join(format!("bionilux-{}", abi.name)))?;
    build_preload(abi, &root, &stage)
}

fn build_preload(abi: &Abi, root: &Path, stage: &Path) -> Result<(), String> {
    let cc = env::var("PRELOAD_CC").unwrap_or_else(|_| abi.preload_cc.to_string());
    let output = stage.join(format!("libbionilux_preload-{}.so", abi.name));
    let mut command = Command::new(cc);
    command
        .current_dir(root)
        .args([
            "-shared",
            "-fPIC",
            "-O2",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-Wl,-soname,libbionilux_preload.so",
            "-Wl,-z,max-page-size=16384",
        ])
        .arg(format!("-Wl,-rpath,{}", abi.preload_rpath))
        .arg("-o")
        .arg(&output)
        .args(["src/preload/hooks.c", "-pthread", "-ldl"]);
    run_command(command)
}

fn backend(abi: &Abi) -> Result<(), String> {
    let root = workspace_root();
    let stage = root.join("target/release-assets");
    let backend = root.join(format!("target/backend-{}", abi.name));
    for dir in ["bin", "lib", "scripts"] {
        fs::create_dir_all(backend.join(dir))
            .map_err(|e| format!("create {}: {e}", backend.join(dir).display()))?;
    }
    copy(
        &stage.join(format!("bionilux-{}", abi.name)),
        &backend.join("bin/bionilux"),
    )?;
    copy(
        &stage.join(format!("libbionilux_preload-{}.so", abi.name)),
        &backend.join("lib/libbionilux_preload.so"),
    )?;
    for script in [
        "prepare-rootfs.sh",
        "prepare-android-rootfs.sh",
        "ldconfig-android.sh",
    ] {
        copy(
            &root.join("scripts").join(script),
            &backend.join("scripts").join(script),
        )?;
    }
    println!("backend: {}", backend.display());
    Ok(())
}

fn loader(abi: &Abi, rootfs: &Path, out: &Path) -> Result<(), String> {
    let source = rootfs.join(abi.debian_loader.trim_start_matches('/'));
    let target = out.join(abi.jni_abi).join("libbionilux-loader.so");
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    copy(&source, &target)?;
    println!("loader: {}", target.display());
    Ok(())
}

fn ndk_path() -> Result<PathBuf, String> {
    for key in ["NDK", "ANDROID_NDK_HOME", "ANDROID_NDK_ROOT"] {
        if let Ok(value) = env::var(key)
            && !value.is_empty()
        {
            return Ok(PathBuf::from(value));
        }
    }
    Err("set NDK / ANDROID_NDK_HOME to the Android NDK root".into())
}

fn ndk_host_tag() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows-x86_64"
    } else if cfg!(target_os = "macos") {
        "darwin-x86_64"
    } else {
        "linux-x86_64"
    }
}

fn copy(source: &Path, target: &Path) -> Result<(), String> {
    fs::copy(source, target)
        .map(|_| ())
        .map_err(|e| format!("copy {} -> {}: {e}", source.display(), target.display()))
}

fn run_command(mut command: Command) -> Result<(), String> {
    let status = command
        .status()
        .map_err(|e| format!("spawn {:?}: {e}", command.get_program()))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{:?} exited with {status}", command.get_program()))
    }
}
