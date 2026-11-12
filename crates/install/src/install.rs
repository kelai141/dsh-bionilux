//! 安装：下载 → 校验 → 解包到暂存 → 自检 → 原子换入 → 状态。
//!
//! 暂存 + rename 的意义是「失败不留半装」：任何一步出错只删暂存目录，已安装的旧 runtime 原封不动。
//! GNU 式的 `rename(staging, slot)` 要求目标不存在，所以换入是先 `slot → .old-*`、再 `staging → slot`、
//! 最后删 `.old-*`；中间任何一步失败都能从 `.old-*` 手工恢复。

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::assets::{AssetKind, AssetSpec, download_verified};
use super::extract::extract_tar_xz;
use super::manifest::Runtime;
use super::{env_root, runtime_dir};

/// 单个 runtime 槽位的固定子路径（与 dsh `instances/<id>/{backend,rootfs}` 同构）。
#[derive(Debug, Clone)]
pub struct Slot {
    pub root: PathBuf,
    pub backend: PathBuf,
    pub rootfs: PathBuf,
    pub node: PathBuf,
}

impl Slot {
    pub fn new(files_dir: &Path, runtime_id: &str) -> Slot {
        let root = runtime_dir(files_dir, runtime_id);
        Slot {
            backend: root.join("backend"),
            rootfs: root.join("rootfs"),
            node: root.join("node"),
            root,
        }
    }

    /// `nativeLibraryDir` 里的 loader 才是 glibc loader 的发布形态（app 数据目录里的不能被 execve）。
    pub fn launcher(&self) -> PathBuf {
        self.backend.join("bin/bionilux")
    }

    pub fn preload(&self) -> PathBuf {
        self.backend.join("lib/libbionilux_preload.so")
    }

    pub fn record_path(&self) -> PathBuf {
        self.root.join("install.json")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub runtime_id: String,
    pub release_version: String,
    pub architecture: String,
    pub installed_at: u64,
    /// 资产名 → sha256（升级时用于判断能不能只换部分资产）
    pub assets: Vec<(String, String)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Downloading,
    Extracting,
    Verifying,
    Activating,
}

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 安装一个 runtime 槽位。`progress(phase, asset_name, done, total)`。
pub fn install<F, C>(
    files_dir: &Path,
    runtime: &Runtime,
    release_version: &str,
    progress: F,
    cancelled: C,
) -> Result<Record, String>
where
    F: Fn(Phase, &str, u64, Option<u64>),
    C: Fn() -> bool,
{
    let specs = runtime.asset_specs()?;
    let slot = Slot::new(files_dir, &runtime.id);
    let staging = env_root(files_dir).join(format!(".staging-{}", runtime.id));
    remove_dir(&staging)?;
    fs::create_dir_all(&staging).map_err(|e| format!("创建暂存目录失败: {e}"))?;

    let cache = env_root(files_dir).join("downloads");
    let mut archives: Vec<(AssetSpec, PathBuf)> = Vec::new();
    for spec in specs {
        if cancelled() {
            remove_dir(&staging)?;
            return Err("已取消".into());
        }
        let archive = cache.join(&spec.name);
        if !archive_matches(&archive, &spec) {
            progress(Phase::Downloading, &spec.name, 0, Some(spec.size));
            let name = spec.name.clone();
            download_verified(
                &spec,
                &cache,
                |done, total| progress(Phase::Downloading, &name, done, total),
                &cancelled,
            )
            .map_err(|e| {
                let _ = remove_dir(&staging);
                format!("下载 {} 失败: {e}", spec.name)
            })?;
        }
        archives.push((spec, archive));
    }

    // 先解压后自检：自检看的是真实布局，不是清单里写的名字。
    let targets = [
        (&slot.backend, AssetKind::Backend),
        (&slot.rootfs, AssetKind::Rootfs),
        (&slot.node, AssetKind::Node),
    ];
    for ((spec, archive), (target, kind)) in archives.iter().zip(targets) {
        if cancelled() {
            remove_dir(&staging)?;
            return Err("已取消".into());
        }
        progress(Phase::Extracting, &spec.name, 0, None);
        let in_staging = staging.join(target.file_name().unwrap_or_default());
        extract_tar_xz(archive, &in_staging, kind).map_err(|e| {
            let _ = remove_dir(&staging);
            format!("解包 {} 失败: {e}", spec.name)
        })?;
    }

    progress(Phase::Verifying, "", 0, None);
    if let Err(error) = verify_layout(&staging, runtime) {
        let _ = remove_dir(&staging);
        return Err(error);
    }

    let record = Record {
        runtime_id: runtime.id.clone(),
        release_version: release_version.to_string(),
        architecture: runtime.architecture.clone(),
        installed_at: now_secs(),
        assets: archives
            .iter()
            .map(|(spec, _)| (spec.name.clone(), spec.sha256.clone()))
            .collect(),
    };
    let text = serde_json::to_string_pretty(&record).map_err(|e| format!("写安装记录失败: {e}"))?;
    fs::write(staging.join("install.json"), text).map_err(|e| format!("写安装记录失败: {e}"))?;

    progress(Phase::Activating, "", 0, None);
    if let Err(error) = activate(staging.clone(), &slot.root) {
        let _ = remove_dir(&staging);
        return Err(error);
    }
    Ok(record)
}

/// 暂存目录 → 槽位目录（保留旧目录直到新目录就位）。
fn activate(staging: PathBuf, slot: &Path) -> Result<(), String> {
    let name = slot
        .file_name()
        .ok_or_else(|| format!("槽位路径没有文件名: {}", slot.display()))?
        .to_string_lossy()
        .into_owned();
    // 固定名字（不用时间戳）：同一槽位同时只会有一个待删的旧目录，重装前先清掉即可。
    let old = slot.with_file_name(format!("{name}.old"));
    if slot.exists() {
        remove_dir(&old)?;
        fs::rename(slot, &old).map_err(|e| format!("移走旧 runtime 失败: {e}"))?;
    }
    if let Err(error) = fs::rename(&staging, slot) {
        // 新目录没就位：把旧目录换回去，别留下一个空槽位。
        if old.exists() {
            let _ = fs::rename(&old, slot);
        }
        return Err(format!("启用新 runtime 失败: {error}"));
    }
    remove_dir(&old)?;
    // Debian minimal rootfs 不带 /etc/resolv.conf（或只留一个指向 systemd-resolved 的坏链），
    // guest 里 apt/dpkg 会因为无法解析仓库域名而失败。装完补一份公网解析器。
    let resolv = slot.join("rootfs/etc/resolv.conf");
    if let Some(parent) = resolv.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::remove_file(&resolv);
    let _ = fs::write(&resolv, "nameserver 8.8.8.8\nnameserver 1.1.1.1\n");
    Ok(())
}

/// 自检只看真实文件：启动器、preload、bash、glibc 解释器、共享 node。
fn verify_layout(root: &Path, runtime: &Runtime) -> Result<(), String> {
    let backend = root.join("backend");
    expect_file(&backend.join("bin/bionilux"), "backend/bin/bionilux")?;
    expect_file(
        &backend.join("lib/libbionilux_preload.so"),
        "backend/lib/libbionilux_preload.so",
    )?;
    let rootfs = root.join("rootfs");
    expect_file(&rootfs.join("bin/bash"), "rootfs/bin/bash")?;
    let loaders = runtime.glibc_loader_candidates();
    if !loaders.iter().any(|rel| rootfs.join(rel).exists()) {
        return Err(format!(
            "rootfs 缺少 glibc 解释器，尝试过: {}",
            loaders.join(", ")
        ));
    }
    if resolve_node_root(&root.join("node"), runtime.node_binary()).is_none() {
        return Err(format!("共享 node 缺少 {}", runtime.node_binary()));
    }
    Ok(())
}

fn expect_file(path: &Path, label: &str) -> Result<(), String> {
    match fs::metadata(path) {
        Ok(meta) if meta.is_file() => Ok(()),
        Ok(_) => Err(format!("{label} 不是普通文件: {}", path.display())),
        Err(_) => Err(format!("缺少 {label}: {}", path.display())),
    }
}

/// node 归档可能是扁平的（`bin/node`）也可能带一层版本目录
/// （`node-v24.22.0-linux-arm64/bin/node`）；两种都认，多一层就报错。
pub fn resolve_node_root(dir: &Path, node_binary: &str) -> Option<PathBuf> {
    if dir.join(node_binary).is_file() {
        return Some(dir.to_path_buf());
    }
    let mut candidates = Vec::new();
    for entry in fs::read_dir(dir).ok()? {
        let entry = entry.ok()?;
        if entry.file_type().ok()?.is_dir() && entry.path().join(node_binary).is_file() {
            candidates.push(entry.path());
        }
    }
    if candidates.len() == 1 {
        return candidates.pop();
    }
    None
}

/// 缓存命中：名称一致、字节数一致，且摘要仍匹配清单。
fn archive_matches(archive: &Path, spec: &AssetSpec) -> bool {
    let Ok(meta) = fs::metadata(archive) else {
        return false;
    };
    if !meta.is_file() || meta.len() != spec.size {
        return false;
    }
    use sha2::{Digest, Sha256};
    let Ok(mut file) = fs::File::open(archive) else {
        return false;
    };
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 256 * 1024];
    loop {
        match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => hasher.update(&buffer[..read]),
            Err(_) => return false,
        }
    }
    let actual: String = hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    actual == spec.sha256
}

/// 兜底清理：进程被杀在解包半途时留下的暂存/旧目录（否则每次中断都会漏几百 MB）。
pub fn cleanup_staging(files_dir: &Path) {
    let Ok(entries) = fs::read_dir(env_root(files_dir)) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(".staging-") || name.ends_with(".old") {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

/// 删目录：不存在算成功（幂等，调用方不必先判断）。
pub fn remove_dir(path: &Path) -> Result<(), String> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("删除 {} 失败: {error}", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::Release;

    const REAL: &str = include_str!("../tests/fixtures/linux-release.json");

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "linux-runtime-install-{name}-{}-{}",
            std::process::id(),
            now_secs()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn touch(path: &Path) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"x").unwrap();
    }

    #[test]
    fn node_root_accepts_flat_and_single_version_directory() {
        let dir = scratch("node-root");
        assert!(resolve_node_root(&dir, "bin/node").is_none());
        touch(&dir.join("bin/node"));
        assert_eq!(resolve_node_root(&dir, "bin/node"), Some(dir.clone()));

        let nested = scratch("node-nested");
        touch(&nested.join("node-v24.22.0-linux-arm64/bin/node"));
        assert_eq!(
            resolve_node_root(&nested, "bin/node"),
            Some(nested.join("node-v24.22.0-linux-arm64"))
        );

        // 两个版本目录并存 = 说不清用哪个，宁可报错
        touch(&nested.join("node-v24.22.1-linux-arm64/bin/node"));
        assert!(resolve_node_root(&nested, "bin/node").is_none());
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&nested);
    }

    #[test]
    fn verify_layout_lists_the_missing_piece() {
        let release = Release::parse(REAL.as_bytes()).unwrap();
        let runtime = release.runtime_for("aarch64").unwrap();
        let root = scratch("verify");
        touch(&root.join("backend/bin/bionilux"));
        touch(&root.join("backend/lib/libbionilux_preload.so"));
        touch(&root.join("rootfs/bin/bash"));
        touch(&root.join("rootfs/usr/lib/ld-linux-aarch64.so.1"));
        touch(&root.join("node/bin/node"));
        // 解释器在 usr/lib（merged-usr）时也要认
        assert!(verify_layout(&root, runtime).is_ok());
        fs::remove_dir_all(root.join("node")).unwrap();
        let error = verify_layout(&root, runtime).unwrap_err();
        assert!(error.contains("node"), "{error}");
        let _ = fs::remove_dir_all(&root);
    }
}
