//! 独立 Linux 环境（bionilux / Debian guest）的获取与安装面。
//!
//! 分层：`manifest`（真实清单）→ `assets`（下载+摘要校验）→ `extract`（安全解包）
//! → `install`（暂存+自检+原子换入）→ `state`（槽位状态机）。
//!
//! 执行面（`linker64 <launcher> --rootfs <R> …`、白名单环境、超时与输出上限）
//! 由消费方应用持有，不在本 crate 内。
//!
//! 三条不可让步的事实：app 数据目录里的 ELF 不能被 execve（必须 `linker64` 首跳）；glibc loader 只从
//! `nativeLibraryDir/libbionilux-loader.so` 生效；`READY` 只由真实执行探针决定，装完不跑探针不进 READY。

pub mod assets;
pub mod extract;
pub mod install;
pub mod manifest;
pub mod state;

use std::path::{Path, PathBuf};

/// 环境根目录名（`<filesDir>/linux-environment`）
pub const ENV_DIR: &str = "linux-environment";

/// 单个资产字节上限（与 dsh `LinuxAssetIO.MAX_DOWNLOAD_BYTES` 对齐）
pub const MAX_ASSET_BYTES: u64 = 512 * 1024 * 1024;

/// 允许的主机：GitHub Releases 本体与其 CDN 跳点。逐跳校验，镜像不在白名单内。
pub const ALLOWED_HOSTS: [&str; 3] = [
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
];

/// 首跳 URL 必须落在固定发布仓的版本目录下——信任锚在这里，不在传输层。
pub const RELEASE_PATH_PREFIX: &str = "/Endlessworld/dsh-bionilux/releases/download/";

pub fn env_root(files_dir: &Path) -> PathBuf {
    files_dir.join(ENV_DIR)
}

/// 运行时槽位目录：每个 `runtimeId` 一套，互不覆盖（允许多 runtime 并存）。
pub fn runtime_dir(files_dir: &Path, runtime_id: &str) -> PathBuf {
    env_root(files_dir).join(runtime_id)
}
