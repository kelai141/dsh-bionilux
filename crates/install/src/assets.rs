//! 资产规格校验与带校验的下载。
//!
//! 三条硬规则（缺一条就不是「失败关闭」）：
//! 1. 只接受 https，且首跳必须落在固定发布仓的 `/releases/download/` 下；跳转逐跳校验主机；
//! 2. 边下边算 sha256，落盘字节数必须同时等于清单的 `size`；任一不符即删除，不留半装；
//! 3. 先写 `.<sha>.part`，校验通过才 rename 成最终名字——中断只会留下可清理的临时文件。

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{ALLOWED_HOSTS, MAX_ASSET_BYTES, RELEASE_PATH_PREFIX};

/// 资产种类决定解包上限与符号链接策略（见 `extract`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AssetKind {
    Plugin,
    Runtime,
    Backend,
    Rootfs,
    Node,
}

impl AssetKind {
    pub fn as_str(self) -> &'static str {
        match self {
            AssetKind::Plugin => "plugin",
            AssetKind::Runtime => "runtime",
            AssetKind::Backend => "backend",
            AssetKind::Rootfs => "rootfs",
            AssetKind::Node => "node",
        }
    }
}

/// 清单里的一条资产（`{kind, name, sha256, size, url}`）。
#[derive(Debug, Clone)]
pub struct AssetSpec {
    pub kind: AssetKind,
    pub name: String,
    pub sha256: String,
    pub size: u64,
    pub url: String,
}

/// 规格自检：不合法就不该发起下载（省一次失败的网络往返，也让错误指向清单而不是网络）。
pub fn spec_verdict(spec: &AssetSpec) -> Result<(), String> {
    if !is_lower_hex_sha256(&spec.sha256) {
        return Err(format!(
            "sha256 必须是 64 位小写十六进制（实际 {} 字符）",
            spec.sha256.len()
        ));
    }
    if spec.size == 0 || spec.size > MAX_ASSET_BYTES {
        return Err(format!(
            "size 必须落在 1..={MAX_ASSET_BYTES}（实际 {}）",
            spec.size
        ));
    }
    if !is_plain_file_name(&spec.name) {
        return Err(format!("资产名只能是单段文件名（实际 {:?}）", spec.name));
    }
    url_verdict(&spec.url)?;
    Ok(())
}

/// 首跳 URL 判定：https + 白名单主机 + 固定发布仓路径前缀。
pub fn url_verdict(url: &str) -> Result<(), String> {
    let (host, path) = split_https(url)?;
    if !host_allowed(&host) {
        return Err(format!("资产主机不在白名单: {host}"));
    }
    if !path.starts_with(RELEASE_PATH_PREFIX) {
        return Err(format!("资产路径不在发布仓目录下: {path}"));
    }
    Ok(())
}

/// 跳转跳点判定：只允许白名单主机（GitHub 会跳到 `objects.githubusercontent.com` 之类的 CDN）。
pub fn hop_verdict(url: &str) -> Result<(), String> {
    let (host, _) = split_https(url)?;
    if !host_allowed(&host) {
        return Err(format!("跳转主机不在白名单: {host}"));
    }
    Ok(())
}

fn host_allowed(host: &str) -> bool {
    ALLOWED_HOSTS
        .iter()
        .any(|allowed| allowed.eq_ignore_ascii_case(host))
}

/// 拆出 `https://host[:port]/path`；拒绝 userinfo、非 https、无路径。
fn split_https(url: &str) -> Result<(String, String), String> {
    let rest = url
        .strip_prefix("https://")
        .ok_or_else(|| format!("只接受 https 资产地址: {url}"))?;
    let (authority, path) = match rest.find('/') {
        Some(index) => (&rest[..index], &rest[index..]),
        None => return Err(format!("资产地址缺少路径: {url}")),
    };
    if authority.is_empty() || authority.contains('@') {
        return Err(format!("资产地址主机非法: {url}"));
    }
    let host = match authority.rsplit_once(':') {
        Some((host, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => host,
        Some(_) => return Err(format!("资产地址端口非法: {url}")),
        None => authority,
    };
    if host.is_empty() {
        return Err(format!("资产地址主机非法: {url}"));
    }
    Ok((host.to_string(), path.to_string()))
}

fn is_lower_hex_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn is_plain_file_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains('\0')
}

/// 下载 + 校验；返回最终落盘路径。
///
/// `progress` 每约 1 MiB 回调一次；`cancelled` 返回 true 时删除临时文件并中止。
pub fn download_verified<P, C>(
    spec: &AssetSpec,
    dest_dir: &Path,
    progress: P,
    cancelled: C,
) -> Result<PathBuf, String>
where
    P: Fn(u64, Option<u64>),
    C: Fn() -> bool,
{
    spec_verdict(spec)?;
    fs::create_dir_all(dest_dir).map_err(|e| format!("创建资产目录失败: {e}"))?;

    let part = dest_dir.join(format!(".{}.part", spec.sha256));
    let final_path = dest_dir.join(&spec.name);
    let _ = fs::remove_file(&part);

    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(20))
        .timeout_read(Duration::from_secs(60))
        .redirects(0)
        .build();

    let response = fetch_following_redirects(&agent, &spec.url, &cancelled)?;
    let mut reader = response.into_reader();
    let mut file = File::create(&part).map_err(|e| format!("创建临时文件失败: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 128 * 1024];
    let mut received: u64 = 0;
    let mut last_report: u64 = 0;

    loop {
        if cancelled() {
            drop(file);
            let _ = fs::remove_file(&part);
            return Err("下载已取消".into());
        }
        let read = reader
            .read(&mut buffer)
            .map_err(|e| fail(&part, format!("读取下载流失败: {e}")))?;
        if read == 0 {
            break;
        }
        received += read as u64;
        if received > spec.size {
            drop(file);
            return Err(fail(
                &part,
                format!("下载体量超过清单声明（>{}）", spec.size),
            ));
        }
        hasher.update(&buffer[..read]);
        file.write_all(&buffer[..read])
            .map_err(|e| fail(&part, format!("写入临时文件失败: {e}")))?;
        if received - last_report >= 1024 * 1024 {
            last_report = received;
            progress(received, Some(spec.size));
        }
    }
    drop(file);
    progress(received, Some(spec.size));

    if received != spec.size {
        return Err(fail(
            &part,
            format!("字节数不符：清单 {}，实际 {received}", spec.size),
        ));
    }
    let actual: String = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if actual != spec.sha256 {
        return Err(fail(
            &part,
            format!("SHA-256 不符：清单 {}，实际 {actual}", spec.sha256),
        ));
    }

    fs::remove_file(&final_path).ok();
    fs::rename(&part, &final_path).map_err(|e| format!("资产落位失败: {e}"))?;
    Ok(final_path)
}

fn fail(part: &Path, message: String) -> String {
    let _ = fs::remove_file(part);
    message
}

/// 拉取一个小文件（清单）：走同一套首跳/跳转校验，带字节上限。
pub fn fetch_bytes(url: &str, max: u64) -> Result<Vec<u8>, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(20))
        .timeout_read(Duration::from_secs(60))
        .redirects(0)
        .build();
    let response = fetch_following_redirects(&agent, url, &|| false)?;
    let status = response.status();
    let mut reader = response.into_reader();
    let mut body = Vec::new();
    let mut buffer = vec![0u8; 16 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|e| format!("读取内容失败: {e}"))?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&buffer[..read]);
        if body.len() as u64 > max {
            return Err(format!("内容超过 {max} 字节上限"));
        }
    }
    if body.is_empty() {
        return Err(format!("响应为空（HTTP {status}）: {url}"));
    }
    Ok(body)
}

fn fetch_following_redirects<C>(
    agent: &ureq::Agent,
    url: &str,
    cancelled: &C,
) -> Result<ureq::Response, String>
where
    C: Fn() -> bool,
{
    url_verdict(url)?;
    let mut current = url.to_string();
    for _ in 0..=MAX_REDIRECTS {
        if cancelled() {
            return Err("下载已取消".into());
        }
        match agent.get(&current).call() {
            Ok(response) => {
                // ureq 在 `redirects(0)` 时把 3xx 当正常响应返回（unit.rs: `redirects == 0` → `Ok(resp)`），
                // 不自己跟就会把空的 302 body 当正文读出来。
                if (300..400).contains(&response.status()) {
                    let location = response
                        .header("location")
                        .ok_or_else(|| format!("跳转 {} 缺少 location", response.status()))?;
                    current = resolve_location(&current, location)?;
                    hop_verdict(&current)?;
                    continue;
                }
                return Ok(response);
            }
            Err(ureq::Error::Status(code, response)) if (300..400).contains(&code) => {
                let location = response
                    .header("location")
                    .ok_or_else(|| format!("跳转 {code} 缺少 location"))?;
                current = resolve_location(&current, location)?;
                hop_verdict(&current)?;
            }
            Err(error) => return Err(format!("下载失败: {error}")),
        }
    }
    Err(format!("跳转次数超过 {MAX_REDIRECTS} 次"))
}

const MAX_REDIRECTS: usize = 5;

/// `Location` 可能是绝对地址、绝对路径，或相对地址（后者一并拒绝——GitHub 只回前两种）。
fn resolve_location(base: &str, location: &str) -> Result<String, String> {
    if location.starts_with("https://") {
        return Ok(location.to_string());
    }
    if location.starts_with("http://") {
        return Err(format!("拒绝降级到 http 的跳转: {location}"));
    }
    if let Some(rest) = location.strip_prefix('/') {
        let (host, _) = split_https(base)?;
        return Ok(format!("https://{host}/{rest}"));
    }
    Err(format!("不支持的跳转地址: {location}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(url: &str, sha: &str, size: u64, name: &str) -> AssetSpec {
        AssetSpec {
            kind: AssetKind::Rootfs,
            name: name.into(),
            sha256: sha.into(),
            size,
            url: url.into(),
        }
    }

    const SHA: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const URL: &str =
        "https://github.com/Endlessworld/dsh-bionilux/releases/download/v1.0.0/rootfs-arm64.tar.xz";

    #[test]
    fn accepts_release_url() {
        assert!(spec_verdict(&spec(URL, SHA, 1024, "rootfs-arm64.tar.xz")).is_ok());
    }

    #[test]
    fn rejects_non_https_and_foreign_hosts() {
        assert!(spec_verdict(&spec(&URL.replace("https://", "http://"), SHA, 1, "a")).is_err());
        assert!(
            spec_verdict(&spec(
                "https://evil.example.com/Endlessworld/dsh-bionilux/releases/download/v1/a.tar.xz",
                SHA,
                1,
                "a"
            ))
            .is_err()
        );
        // 前缀对了但主机错：仍然拒绝
        assert!(spec_verdict(&spec(
            "https://raw.githubusercontent.com/Endlessworld/dsh-bionilux/releases/download/v1/a.tar.xz",
            SHA,
            1,
            "a"
        ))
        .is_err());
    }

    #[test]
    fn rejects_path_outside_release_dir() {
        assert!(
            spec_verdict(&spec(
                "https://github.com/Endlessworld/dsh-bionilux/archive/v1.0.0.tar.gz",
                SHA,
                1,
                "a"
            ))
            .is_err()
        );
    }

    #[test]
    fn rejects_userinfo_and_bad_ports() {
        assert!(
            url_verdict(
                "https://github.com@evil.com/Endlessworld/dsh-bionilux/releases/download/v1/a"
            )
            .is_err()
        );
        assert!(
            url_verdict("https://github.com:abc/Endlessworld/dsh-bionilux/releases/download/v1/a")
                .is_err()
        );
        assert!(
            url_verdict("https://github.com:443/Endlessworld/dsh-bionilux/releases/download/v1/a")
                .is_ok()
        );
    }

    #[test]
    fn rejects_uppercase_or_short_digest() {
        assert!(spec_verdict(&spec(URL, &SHA.to_uppercase(), 1, "a")).is_err());
        assert!(spec_verdict(&spec(URL, "abc", 1, "a")).is_err());
    }

    #[test]
    fn rejects_bad_size_and_names() {
        assert!(spec_verdict(&spec(URL, SHA, 0, "a")).is_err());
        assert!(spec_verdict(&spec(URL, SHA, MAX_ASSET_BYTES + 1, "a")).is_err());
        assert!(spec_verdict(&spec(URL, SHA, 1, "../a")).is_err());
        assert!(spec_verdict(&spec(URL, SHA, 1, "dir/a")).is_err());
        assert!(spec_verdict(&spec(URL, SHA, 1, "")).is_err());
    }

    #[test]
    fn hop_allows_only_allowlisted_hosts() {
        assert!(hop_verdict("https://objects.githubusercontent.com/x/y").is_ok());
        assert!(hop_verdict("https://evil.example.com/x/y").is_err());
        assert!(hop_verdict("http://objects.githubusercontent.com/x").is_err());
    }

    #[test]
    fn resolves_absolute_path_location() {
        assert_eq!(
            resolve_location(URL, "/Endlessworld/dsh-bionilux/releases/download/v1/b").unwrap(),
            "https://github.com/Endlessworld/dsh-bionilux/releases/download/v1/b"
        );
        assert!(resolve_location(URL, "relative/path").is_err());
        assert!(resolve_location(URL, "http://github.com/x").is_err());
    }

    #[test]
    #[ignore = "needs network: real GitHub release manifest (302 -> objects.githubusercontent.com)"]
    fn fetches_real_manifest_through_redirects() {
        let url = "https://github.com/Endlessworld/dsh-bionilux/releases/download/v0.10.0/linux-release.json";
        let body = fetch_bytes(url, 64 * 1024).expect("real manifest fetch");
        let text = String::from_utf8(body).expect("utf8");
        assert!(
            text.contains("schemaVersion"),
            "body: {}",
            &text[..text.len().min(200)]
        );
    }
}
