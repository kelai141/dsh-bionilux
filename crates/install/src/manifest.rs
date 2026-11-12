//! `linux-release.json` 清单解析。
//!
//! 形状对齐 bionilux v0.10.0 的真实清单（`src-tauri/tests/fixtures/linux-release.json`）：
//!
//! ```json
//! { "schemaVersion": 1, "version": "0.10.0", "minMobileVersion": "0.14.0",
//!   "plugins": { ... },
//!   "runtimes": [ { "id": "debian-minimal", "architecture": "arm64",
//!                   "backend": "bionilux",
//!                   "backendAsset|rootfsAsset|nodeAsset": { url, sha256, size, unpackedSize } } ] }
//! ```
//!
//! `plugins`（dsh 的 Cordis JS 插件）对我们没有意义，**故意不解析**。loader 不在清单里：
//! 它是 APK 的原生库（`lib/<abi>/libbionilux-loader.so`），版本必须与 rootfs 钉在同一 release。
//!
//! 校验全部失败关闭：schema、架构拼写、资产 URL/摘要/体积；选不到本架构的 runtime 一律报错，
//! 不回落另一架构（架构不符的 rootfs 装上也跑不起来，只会更晚、更难查地失败）。

use serde::Deserialize;

use super::assets::{AssetKind, AssetSpec, spec_verdict};
use super::extract::limits_for;

pub const SUPPORTED_SCHEMA: u32 = 1;

/// 清单允许的架构拼写（bionilux 用 `arm64` / `x64`）。
pub const ARCH_ARM64: &str = "arm64";
pub const ARCH_X64: &str = "x64";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    pub schema_version: u32,
    pub version: String,
    #[serde(default)]
    pub min_mobile_version: Option<String>,
    #[serde(default)]
    pub runtimes: Vec<Runtime>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Runtime {
    pub id: String,
    pub label: String,
    pub architecture: String,
    pub backend: String,
    pub backend_asset: Asset,
    pub rootfs_asset: Asset,
    pub node_asset: Asset,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub url: String,
    pub sha256: String,
    pub size: u64,
    #[serde(default)]
    pub unpacked_size: u64,
}

impl Release {
    pub fn parse(bytes: &[u8]) -> Result<Release, String> {
        let release: Release = serde_json::from_slice(bytes)
            .map_err(|error| format!("清单不是有效的 JSON: {error}"))?;
        release.verify()?;
        Ok(release)
    }

    fn verify(&self) -> Result<(), String> {
        if self.schema_version != SUPPORTED_SCHEMA {
            return Err(format!(
                "不支持的清单 schemaVersion {}（只支持 {SUPPORTED_SCHEMA}）",
                self.schema_version
            ));
        }
        if self.version.trim().is_empty() {
            return Err("清单缺少 version".into());
        }
        if self.runtimes.is_empty() {
            return Err("清单没有任何 runtime".into());
        }
        for runtime in &self.runtimes {
            runtime.verify()?;
        }
        Ok(())
    }

    /// 按宿主 ABI（`aarch64` / `x86_64`）选 runtime；选不到就报错，不回落。
    pub fn runtime_for(&self, host_arch: &str) -> Result<&Runtime, String> {
        let wanted = arch_key(host_arch)?;
        self.runtimes
            .iter()
            .find(|runtime| runtime.architecture == wanted)
            .ok_or_else(|| {
                format!("清单里没有 {wanted} 的 runtime（宿主 {host_arch}），不回落其他架构")
            })
    }
}

impl Runtime {
    fn verify(&self) -> Result<(), String> {
        if self.id.is_empty()
            || self.id.len() > 64
            || !self.id.bytes().all(|b| {
                b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'.' | b'_')
            })
        {
            return Err(format!("runtime id 不合法: {:?}", self.id));
        }
        if self.architecture != ARCH_ARM64 && self.architecture != ARCH_X64 {
            return Err(format!(
                "runtime {} 的 architecture 只能是 {ARCH_ARM64} 或 {ARCH_X64}（实际 {}）",
                self.id, self.architecture
            ));
        }
        if self.backend != "bionilux" {
            return Err(format!("未知的 backend: {}", self.backend));
        }
        for (kind, asset) in self.assets_with_kind() {
            let spec = asset.to_spec(kind)?;
            spec_verdict(&spec)?;
            if asset.unpacked_size > limits_for(kind).max_bytes {
                return Err(format!(
                    "{} 的解包声明 {} 字节超过该类型上限 {}（清单不能放宽炸弹防护）",
                    kind.as_str(),
                    asset.unpacked_size,
                    limits_for(kind).max_bytes
                ));
            }
        }
        Ok(())
    }

    fn assets_with_kind(&self) -> [(AssetKind, &Asset); 3] {
        [
            (AssetKind::Backend, &self.backend_asset),
            (AssetKind::Rootfs, &self.rootfs_asset),
            (AssetKind::Node, &self.node_asset),
        ]
    }

    /// 三份待下载资产，顺序固定（backend → rootfs → node）。
    pub fn asset_specs(&self) -> Result<Vec<AssetSpec>, String> {
        self.assets_with_kind()
            .into_iter()
            .map(|(kind, asset)| asset.to_spec(kind))
            .collect()
    }

    /// 解包后字节声明之和（用于安装前磁盘预检）。
    pub fn unpacked_bytes(&self) -> u64 {
        self.backend_asset.unpacked_size
            + self.rootfs_asset.unpacked_size
            + self.node_asset.unpacked_size
    }

    /// 宿主 ABI 对应的 glibc 解释器候选（相对 rootfs）。
    ///
    /// merged-usr 的 Debian 里 `/lib -> usr/lib`，所以物理路径是 `usr/lib/...`；两者都认，
    /// 免得安装自检依赖“符号链接能穿越”这一件事。
    pub fn glibc_loader_candidates(&self) -> &'static [&'static str] {
        if self.architecture == ARCH_ARM64 {
            &[
                "lib/ld-linux-aarch64.so.1",
                "usr/lib/ld-linux-aarch64.so.1",
                "lib64/ld-linux-aarch64.so.1",
            ]
        } else {
            &[
                "lib64/ld-linux-x86-64.so.2",
                "usr/lib64/ld-linux-x86-64.so.2",
                "lib/ld-linux-x86-64.so.2",
                "usr/lib/ld-linux-x86-64.so.2",
            ]
        }
    }

    /// 共享 glibc Node 在 guest 内的可执行文件名。
    pub fn node_binary(&self) -> &'static str {
        "bin/node"
    }
}

impl Asset {
    fn to_spec(&self, kind: AssetKind) -> Result<AssetSpec, String> {
        let name = self
            .url
            .rsplit('/')
            .next()
            .filter(|name| !name.is_empty())
            .ok_or_else(|| format!("资产 URL 没有文件名: {}", self.url))?;
        Ok(AssetSpec {
            kind,
            name: name.to_string(),
            sha256: self.sha256.clone(),
            size: self.size,
            url: self.url.clone(),
        })
    }
}

/// `aarch64` / `x86_64`（`std::env::consts::ARCH` 的写法）→ 清单拼写。
pub fn arch_key(host_arch: &str) -> Result<&'static str, String> {
    match host_arch {
        "aarch64" => Ok(ARCH_ARM64),
        "x86_64" => Ok(ARCH_X64),
        other => Err(format!(
            "不支持的宿主架构 {other}（只支持 aarch64 / x86_64）"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const REAL: &str = include_str!("../tests/fixtures/linux-release.json");

    #[test]
    fn parses_the_real_release() {
        let release = Release::parse(REAL.as_bytes()).expect("real manifest must parse");
        assert_eq!(release.schema_version, SUPPORTED_SCHEMA);
        assert_eq!(release.version, "0.10.0");
        assert_eq!(release.runtimes.len(), 2);
        let arm = release.runtime_for("aarch64").unwrap();
        assert_eq!(arm.id, "debian-minimal");
        assert_eq!(arm.backend_asset.size, 520276);
        assert_eq!(arm.rootfs_asset.unpacked_size, 237792158);
    }

    #[test]
    fn selects_the_matching_architecture_only() {
        let release = Release::parse(REAL.as_bytes()).unwrap();
        assert_eq!(
            release.runtime_for("x86_64").unwrap().id,
            "debian-minimal-x64"
        );
        assert!(release.runtime_for("riscv64").is_err());
        assert!(release.runtime_for("").is_err());
    }

    #[test]
    fn asset_specs_keep_names_and_kinds_in_order() {
        let release = Release::parse(REAL.as_bytes()).unwrap();
        let specs = release
            .runtime_for("aarch64")
            .unwrap()
            .asset_specs()
            .unwrap();
        assert_eq!(specs[0].kind, AssetKind::Backend);
        assert_eq!(specs[1].kind, AssetKind::Rootfs);
        assert_eq!(specs[2].kind, AssetKind::Node);
        assert_eq!(specs[1].name, "debian-minimal-aarch64.tar.xz");
        for spec in &specs {
            spec_verdict(spec).unwrap();
        }
    }

    #[test]
    fn rejects_unknown_schema_and_missing_runtimes() {
        let broken = REAL.replace("\"schemaVersion\": 1", "\"schemaVersion\": 2");
        assert!(Release::parse(broken.as_bytes()).is_err());
        assert!(Release::parse(br#"{"schemaVersion":1,"version":"1","runtimes":[]}"#).is_err());
    }

    #[test]
    fn rejects_architecture_typos_and_bad_assets() {
        let typo = REAL.replace(
            "\"architecture\": \"arm64\"",
            "\"architecture\": \"aarch64\"",
        );
        assert!(Release::parse(typo.as_bytes()).is_err());
        let http = REAL.replace(
            "https://github.com/Endlessworld/dsh-bionilux/releases/download/v0.10.0/debian-minimal-aarch64.tar.xz",
            "http://github.com/Endlessworld/dsh-bionilux/releases/download/v0.10.0/debian-minimal-aarch64.tar.xz",
        );
        assert!(Release::parse(http.as_bytes()).is_err());
        let upper = REAL.replacen(
            "98f2160e7a9d2cb681ae628adb2d6186402f206a39282b4804f8eb21f90d6f5f",
            "98F2160E7A9D2CB681AE628ADB2D6186402F206A39282B4804F8EB21F90D6F5F",
            1,
        );
        assert!(Release::parse(upper.as_bytes()).is_err());
    }

    #[test]
    fn rejects_unpacked_size_above_the_kind_budget() {
        let blown = REAL.replace(
            "\"unpackedSize\": 237792158",
            "\"unpackedSize\": 999999999999",
        );
        assert!(Release::parse(blown.as_bytes()).is_err());
    }
}
