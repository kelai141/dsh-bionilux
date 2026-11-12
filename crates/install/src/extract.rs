//! `.tar.xz` 安全解包。
//!
//! 拒绝面（全部失败关闭，不留半装）：
//! - 绝对条目名、`.`/`..` 段、空名；
//! - 硬链接、字符/块设备、FIFO、socket、未知类型；
//! - 非 rootfs 资产的符号链接；rootfs 允许 guest 绝对路径（`/usr/...`）与指向包内的相对链接；
//! - 穿过已存在符号链接写文件（先 create 一个指向外部的链接，再用它做父目录的经典逃逸）；
//! - 条目数与解包后字节数超过该 kind 的上限（压缩炸弹）。

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use super::assets::AssetKind;

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub max_entries: u64,
    pub max_bytes: u64,
    pub allow_guest_symlink: bool,
    /// 把 rootfs 里的绝对符号链接改写成相对链接。
    ///
    /// rootfs 预置的 `/etc/localtime -> /usr/share/zoneinfo/Etc/UTC` 在内核看来是**宿主**的
    /// `/usr/share/...`（guest 只重定向传给 syscall 的路径，链接目标由内核解析）→ 必须改写成
    /// 相对链接才指向 rootfs 内。用相对而非物理绝对路径，是因为解包在暂存目录、之后要 rename
    /// 到最终位置，物理绝对路径会当场失效。代价：guest 里 `readlink` 看到的是相对目标。
    pub rewrite_absolute_links: bool,
}

pub fn limits_for(kind: AssetKind) -> Limits {
    let max_bytes = match kind {
        AssetKind::Plugin => 64 * 1024 * 1024,
        AssetKind::Backend => 32 * 1024 * 1024,
        AssetKind::Runtime => 256 * 1024 * 1024,
        AssetKind::Node => 2 * 1024 * 1024 * 1024,
        AssetKind::Rootfs => 8 * 1024 * 1024 * 1024,
    };
    let max_entries = match kind {
        AssetKind::Plugin => 20_000,
        AssetKind::Backend => 100,
        AssetKind::Runtime => 40_000,
        AssetKind::Node => 60_000,
        AssetKind::Rootfs => 240_000,
    };
    Limits {
        max_entries,
        max_bytes,
        allow_guest_symlink: matches!(kind, AssetKind::Rootfs | AssetKind::Node),
        rewrite_absolute_links: matches!(kind, AssetKind::Rootfs),
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Stats {
    pub entries: u64,
    pub bytes: u64,
    pub links: u64,
}

/// 解 `.tar.xz`（xz 字典上限 256 MiB：正常 rootfs 用 -6/-9，超限即视为炸弹）。
pub fn extract_tar_xz(archive: &Path, dest: &Path, kind: AssetKind) -> Result<Stats, String> {
    let file = File::open(archive).map_err(|e| format!("打开资产失败: {e}"))?;
    let reader = lzma_rust2::XzReader::new_mem_limit(file, false, 256 * 1024);
    extract_tar(reader, dest, limits_for(kind))
}

/// 解未压缩的 tar 流；测试直接喂内存 tar，不必造 xz。
pub fn extract_tar<R: Read>(reader: R, dest: &Path, limits: Limits) -> Result<Stats, String> {
    fs::create_dir_all(dest).map_err(|e| format!("创建解包目录失败: {e}"))?;
    let mut archive = tar::Archive::new(reader);
    let mut stats = Stats::default();

    for entry in archive
        .entries()
        .map_err(|e| format!("解析 tar 失败: {e}"))?
    {
        let mut entry = entry.map_err(|e| format!("读取 tar 条目失败: {e}"))?;
        stats.entries += 1;
        if stats.entries > limits.max_entries {
            return Err(format!("条目数超过上限 {}", limits.max_entries));
        }

        let segments = entry_segments(&entry.path_bytes())?;
        let entry_type = entry.header().entry_type();
        if segments.is_empty() {
            // 归档首条通常是 `./`（只是一个目录条目）；非目录条目取不到名字才是坏归档。
            if entry_type.is_dir() {
                continue;
            }
            return Err("条目名为空".into());
        }
        let relative: PathBuf = segments.iter().collect();

        if entry_type.is_symlink() {
            if !limits.allow_guest_symlink {
                return Err(format!("资产类型不允许符号链接: {}", relative.display()));
            }
            let target = entry
                .link_name_bytes()
                .ok_or_else(|| format!("符号链接缺少目标: {}", relative.display()))?;
            symlink_target_verdict(&segments, &target)?;
            if !limits.rewrite_absolute_links && target.starts_with(b"/") {
                // 非 rootfs（node）只收相对链接：绝对链接在内核眼里指向宿主文件系统。
                return Err(format!("符号链接必须是相对路径: {}", relative.display()));
            }
            let target = if limits.rewrite_absolute_links && target.starts_with(b"/") {
                relative_link_target(&segments, &target)?
            } else {
                target.into_owned()
            };
            let link_path = join_guarded(dest, &segments)?;
            if let Some(parent) = link_path.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
            }
            let _ = fs::remove_file(&link_path);
            symlink(&target, &link_path)?;
            stats.links += 1;
            continue;
        }

        match entry_type {
            tar::EntryType::Directory => {
                fs::create_dir_all(join_guarded(dest, &segments)?)
                    .map_err(|e| format!("创建目录失败: {e}"))?;
            }
            tar::EntryType::Regular | tar::EntryType::Continuous => {
                let target = join_guarded(dest, &segments)?;
                // 先看声明尺寸：单个条目就能把预算吃穿时，不必先写 10 GB 再报错
                let declared = entry.header().size().unwrap_or(0);
                if stats.bytes.saturating_add(declared) > limits.max_bytes {
                    return Err(format!(
                        "解包体积超过上限 {} 字节（条目 {}）",
                        limits.max_bytes,
                        relative.display()
                    ));
                }
                prepare_file_target(&target)?;
                let mut out = File::create(&target)
                    .map_err(|e| format!("写入 {} 失败: {e}", target.display()))?;
                let mut buffer = vec![0u8; 128 * 1024];
                loop {
                    let read = entry
                        .read(&mut buffer)
                        .map_err(|e| format!("解包 {} 失败: {e}", target.display()))?;
                    if read == 0 {
                        break;
                    }
                    stats.bytes += read as u64;
                    if stats.bytes > limits.max_bytes {
                        return Err(format!("解包体积超过上限 {} 字节", limits.max_bytes));
                    }
                    out.write_all(&buffer[..read])
                        .map_err(|e| format!("写入 {} 失败: {e}", target.display()))?;
                }
                apply_mode(&target, entry.header().mode().ok());
            }
            other => {
                return Err(format!(
                    "不支持的条目类型 {other:?}: {}",
                    relative.display()
                ));
            }
        }
    }
    Ok(stats)
}

/// 条目名切段：拒绝绝对路径、`..`、空段与空名。
fn entry_segments(raw: &[u8]) -> Result<Vec<PathBuf>, String> {
    if raw.is_empty() {
        return Err("条目名为空".into());
    }
    if raw[0] == b'/' {
        return Err(format!("拒绝绝对条目名: {}", String::from_utf8_lossy(raw)));
    }
    let mut segments = Vec::new();
    for segment in raw.split(|byte| *byte == b'/') {
        if segment.is_empty() || segment == b"." {
            continue;
        }
        if segment == b".." {
            return Err(format!("拒绝路径穿越: {}", String::from_utf8_lossy(raw)));
        }
        segments.push(PathBuf::from(String::from_utf8_lossy(segment).into_owned()));
    }
    if segments.is_empty() {
        return Ok(segments);
    }
    Ok(segments)
}

/// 符号链接目标判定：只允许 guest 绝对路径（`/usr/...`）或不出解包根的相对路径。
fn symlink_target_verdict(link: &[PathBuf], target: &[u8]) -> Result<(), String> {
    let text = String::from_utf8_lossy(target).into_owned();
    if text.is_empty() {
        return Err("符号链接目标为空".into());
    }
    if text.starts_with('/') {
        // guest 绝对路径：在 rootfs 内解析，与宿主无交集，安全。
        return Ok(());
    }
    // 相对路径：从链接所在的父目录出发，`..` 不得越过解包根。
    let mut depth = link.len().saturating_sub(1) as i64;
    for segment in text.split('/') {
        match segment {
            "" | "." => continue,
            ".." => {
                depth -= 1;
                if depth < 0 {
                    return Err(format!("符号链接逃出解包根: {text}"));
                }
            }
            _ => depth += 1,
        }
    }
    Ok(())
}

/// 逐段创建父目录，遇到已存在的符号链接直接失败（否则后续写入会跟着它跑出解包根）。
fn join_guarded(dest: &Path, segments: &[PathBuf]) -> Result<PathBuf, String> {
    let mut current = dest.to_path_buf();
    for (index, segment) in segments.iter().enumerate() {
        current.push(segment);
        if index + 1 == segments.len() {
            break;
        }
        match fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(format!("拒绝穿过符号链接写入: {}", current.display()));
            }
            Ok(meta) if !meta.is_dir() => {
                return Err(format!("路径中间不是目录: {}", current.display()));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(|e| format!("创建目录失败: {e}"))?;
            }
            Err(error) => return Err(format!("检查路径失败: {error}")),
        }
    }
    Ok(current)
}

/// 把 guest 绝对链接目标改写成相对目标（相对链接自身所在目录）。
///
/// 例：`etc/localtime -> /usr/share/zoneinfo/Etc/UTC` 变成 `../usr/share/zoneinfo/Etc/UTC`；
/// 根目录下的链接没有 `..` 前缀（`a -> /b/c` 变成 `b/c`）。
fn relative_link_target(link: &[PathBuf], target: &[u8]) -> Result<Vec<u8>, String> {
    let text = String::from_utf8_lossy(target);
    let mut parts: Vec<&str> = Vec::new();
    for segment in text.trim_start_matches('/').split('/') {
        match segment {
            "" | "." => continue,
            ".." => return Err(format!("绝对链接目标里不允许 `..`: {text}")),
            other => parts.push(other),
        }
    }
    let depth = link.len().saturating_sub(1);
    let mut out: Vec<String> = std::iter::repeat_n("..".to_string(), depth).collect();
    out.extend(parts.iter().map(|part| (*part).to_string()));
    if out.is_empty() {
        // 根目录下的链接指向 `/`：相对目标就是自身所在目录。
        return Ok(b".".to_vec());
    }
    Ok(out.join("/").into_bytes())
}

/// 写文件前的最后一道防线：同名位置已经是指向外部的符号链接时，`File::create` 会跟着它写出去。
fn prepare_file_target(target: &Path) -> Result<(), String> {
    match fs::symlink_metadata(target) {
        Ok(meta) if meta.file_type().is_symlink() || meta.is_file() => {
            fs::remove_file(target).map_err(|e| format!("清理同名文件失败: {e}"))
        }
        Ok(_) => Err(format!("同名位置已存在且不是文件: {}", target.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("检查目标失败: {error}")),
    }
}

#[cfg(unix)]
fn symlink(target: &[u8], at: &Path) -> Result<(), String> {
    use std::os::unix::ffi::OsStrExt;
    let target = std::ffi::OsStr::from_bytes(target);
    std::os::unix::fs::symlink(target, at).map_err(|e| format!("创建符号链接失败: {e}"))
}

#[cfg(not(unix))]
fn symlink(_target: &[u8], at: &Path) -> Result<(), String> {
    Err(format!("宿主不支持符号链接: {}", at.display()))
}

fn apply_mode(path: &Path, mode: Option<u32>) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = mode.unwrap_or(0o644) & 0o777;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "linux-runtime-test-{name}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 手工拼 tar：`tar` crate 的写入侧会拒绝绝对路径与 `..`，而解包侧必须能识别恶意归档，
    /// 所以负面用例不能走 Builder。
    struct Raw<'a> {
        name: &'a str,
        typeflag: u8,
        body: &'a [u8],
        link: Option<&'a str>,
    }

    fn put(header: &mut [u8; 512], offset: usize, bytes: &[u8]) {
        header[offset..offset + bytes.len()].copy_from_slice(bytes);
    }

    fn raw_tar(entries: &[Raw<'_>]) -> Vec<u8> {
        let mut out = Vec::new();
        for entry in entries {
            let mut header = [0u8; 512];
            put(&mut header, 0, entry.name.as_bytes());
            put(&mut header, 100, b"0000644\0");
            put(&mut header, 108, b"0000000\0");
            put(&mut header, 116, b"0000000\0");
            put(
                &mut header,
                124,
                format!("{:011o}\0", entry.body.len()).as_bytes(),
            );
            put(&mut header, 136, b"00000000000\0");
            put(&mut header, 148, b"        ");
            header[156] = entry.typeflag;
            if let Some(link) = entry.link {
                put(&mut header, 157, link.as_bytes());
            }
            put(&mut header, 257, b"ustar\0");
            put(&mut header, 263, b"00");
            let sum: u32 = header.iter().map(|byte| *byte as u32).sum();
            put(&mut header, 148, format!("{:06o}\0 ", sum).as_bytes());
            out.extend_from_slice(&header);
            out.extend_from_slice(entry.body);
            out.resize(out.len().div_ceil(512) * 512, 0);
        }
        out.extend_from_slice(&[0u8; 1024]);
        out
    }

    fn file<'a>(name: &'a str, body: &'a [u8]) -> Raw<'a> {
        Raw {
            name,
            typeflag: b'0',
            body,
            link: None,
        }
    }

    fn symlink<'a>(name: &'a str, target: &'a str) -> Raw<'a> {
        Raw {
            name,
            typeflag: b'2',
            body: b"",
            link: Some(target),
        }
    }

    #[test]
    fn extracts_regular_tree() {
        let dir = scratch("ok");
        let bytes = raw_tar(&[
            file("rootfs/bin/bash", b"#!/bin/sh\n"),
            file("rootfs/readme", b"hi"),
        ]);
        let stats = extract_tar(Cursor::new(bytes), &dir, limits_for(AssetKind::Rootfs)).unwrap();
        assert_eq!(stats.entries, 2);
        assert!(dir.join("rootfs/bin/bash").is_file());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn extracts_xz_archive() {
        let dir = scratch("xz");
        let archive = dir.join("hello.tar.xz");
        fs::write(&archive, include_bytes!("../tests/fixtures/hello.tar.xz")).unwrap();
        let stats = extract_tar_xz(&archive, &dir.join("out"), AssetKind::Rootfs).unwrap();
        assert_eq!(stats.entries, 1);
        assert_eq!(fs::read_to_string(dir.join("out/hello.txt")).unwrap(), "ok");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_absolute_name() {
        let dir = scratch("abs");
        let bytes = raw_tar(&[file("/etc/passwd", b"x")]);
        let error =
            extract_tar(Cursor::new(bytes), &dir, limits_for(AssetKind::Rootfs)).unwrap_err();
        assert!(error.contains("绝对条目名"), "{error}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_parent_traversal() {
        let dir = scratch("dotdot");
        let bytes = raw_tar(&[file("a/../../escape", b"x")]);
        let error =
            extract_tar(Cursor::new(bytes), &dir, limits_for(AssetKind::Rootfs)).unwrap_err();
        assert!(error.contains("路径穿越"), "{error}");
        assert!(!dir.parent().unwrap().join("escape").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_hardlink_and_fifo() {
        let dir = scratch("link-fifo");
        let hard = raw_tar(&[
            file("a", b"x"),
            Raw {
                name: "b",
                typeflag: b'1',
                body: b"",
                link: Some("a"),
            },
        ]);
        assert!(extract_tar(Cursor::new(hard), &dir, limits_for(AssetKind::Rootfs)).is_err());

        let fifo = raw_tar(&[Raw {
            name: "p",
            typeflag: b'6',
            body: b"",
            link: None,
        }]);
        assert!(extract_tar(Cursor::new(fifo), &dir, limits_for(AssetKind::Rootfs)).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn plugin_rejects_symlink() {
        let dir = scratch("symlink-kind");
        let bytes = raw_tar(&[symlink("lib/libc.so", "/usr/lib/libc.so.6")]);
        let error =
            extract_tar(Cursor::new(bytes), &dir, limits_for(AssetKind::Plugin)).unwrap_err();
        assert!(error.contains("不允许符号链接"), "{error}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn node_accepts_relative_symlink_but_not_absolute() {
        // 真实 node 包带 bin/npm、bin/corepack 这类相对链接（`../lib/node_modules/...`）。
        let dir = scratch("node-symlink");
        let ok = raw_tar(&[symlink("bin/npm", "../lib/node_modules/npm/bin/npm-cli.js")]);
        assert!(extract_tar(Cursor::new(ok), &dir, limits_for(AssetKind::Node)).is_ok());
        assert!(
            fs::symlink_metadata(dir.join("bin/npm"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
        let bad = raw_tar(&[symlink("bin/corepack", "/data/local/tmp/x")]);
        let error = extract_tar(Cursor::new(bad), &dir, limits_for(AssetKind::Node)).unwrap_err();
        assert!(error.contains("相对路径"), "{error}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_symlink_escaping_root() {
        let dir = scratch("escape");
        let bytes = raw_tar(&[symlink("a/link", "../../../etc/passwd")]);
        let error =
            extract_tar(Cursor::new(bytes), &dir, limits_for(AssetKind::Rootfs)).unwrap_err();
        assert!(error.contains("逃出解包根"), "{error}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn rootfs_accepts_guest_absolute_symlink() {
        let dir = scratch("symlink-ok");
        let bytes = raw_tar(&[symlink("lib/libc.so", "/usr/lib/libc.so.6")]);
        assert!(extract_tar(Cursor::new(bytes), &dir, limits_for(AssetKind::Rootfs)).is_ok());
        assert!(
            fs::symlink_metadata(dir.join("lib/libc.so"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_write_through_symlink() {
        let dir = scratch("through");
        let bytes = raw_tar(&[symlink("out", "/sdcard"), file("out/pwn", b"x")]);
        let error =
            extract_tar(Cursor::new(bytes), &dir, limits_for(AssetKind::Rootfs)).unwrap_err();
        assert!(error.contains("穿过符号链接"), "{error}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn symlink_target_rules() {
        let link = vec![PathBuf::from("a"), PathBuf::from("b")];
        assert!(symlink_target_verdict(&link, b"/usr/lib/libc.so.6").is_ok());
        assert!(symlink_target_verdict(&link, b"../libc.so.6").is_ok());
        // 链接在 a/b，父目录是 a：两个 `..` 就到了解包根之外
        assert!(symlink_target_verdict(&link, b"../../libc.so.6").is_err());
        assert!(symlink_target_verdict(&link, b"../../../libc.so.6").is_err());
        assert!(symlink_target_verdict(&link, b"").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_file_over_symlink() {
        let dir = scratch("file-over-link");
        let bytes = raw_tar(&[symlink("a", "/tmp/pwned"), file("a", b"x")]);
        let error =
            extract_tar(Cursor::new(bytes), &dir, limits_for(AssetKind::Rootfs)).unwrap_err();
        assert!(error.contains("不是文件") || error.contains("穿"));
        assert!(!Path::new("/tmp/pwned").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn enforces_entry_budget() {
        let dir = scratch("budget");
        let bytes = raw_tar(&[file("f0", b"x"), file("f1", b"x"), file("f2", b"x")]);
        let limits = Limits {
            max_entries: 2,
            max_bytes: 1024,
            allow_guest_symlink: false,
            rewrite_absolute_links: false,
        };
        assert!(extract_tar(Cursor::new(bytes), &dir, limits).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn enforces_byte_budget() {
        let dir = scratch("bytes");
        let bytes = raw_tar(&[file("big", &[0u8; 64])]);
        let limits = Limits {
            max_entries: 10,
            max_bytes: 16,
            allow_guest_symlink: false,
            rewrite_absolute_links: false,
        };
        assert!(extract_tar(Cursor::new(bytes), &dir, limits).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn relative_link_target_matches_the_documented_examples() {
        let link = vec![PathBuf::from("etc"), PathBuf::from("localtime")];
        let rewritten = relative_link_target(&link, b"/usr/share/zoneinfo/Etc/UTC").unwrap();
        assert_eq!(
            String::from_utf8(rewritten).unwrap(),
            "../usr/share/zoneinfo/Etc/UTC"
        );
        // 根目录下的链接：没有 `..` 前缀
        let root_link = vec![PathBuf::from("a")];
        assert_eq!(
            String::from_utf8(relative_link_target(&root_link, b"/b/c").unwrap()).unwrap(),
            "b/c"
        );
        // 目标是 `/` 本身就是自身目录
        assert_eq!(
            relative_link_target(&root_link, b"/").unwrap(),
            b".".to_vec()
        );
        // 绝对目标里带 `..` 不予猜测
        assert!(relative_link_target(&link, b"/usr/../etc/passwd").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rootfs_extraction_rewrites_guest_absolute_links() {
        let dir = scratch("rewrite-links");
        let bytes = raw_tar(&[
            file("usr/share/zoneinfo/Etc/UTC", b"zone"),
            symlink("etc/localtime", "/usr/share/zoneinfo/Etc/UTC"),
            symlink("liblink", "/usr/lib"),
        ]);
        extract_tar(Cursor::new(bytes), &dir, limits_for(AssetKind::Rootfs)).unwrap();
        assert_eq!(
            fs::read_link(dir.join("etc/localtime")).unwrap(),
            PathBuf::from("../usr/share/zoneinfo/Etc/UTC")
        );
        assert_eq!(
            fs::read_link(dir.join("liblink")).unwrap(),
            PathBuf::from("usr/lib")
        );
        // 改写后的链接在解包根内自然解析
        assert_eq!(
            fs::read_to_string(dir.join("etc/localtime")).unwrap(),
            "zone"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// 真归档回归（不放进默认测试：要 51 MB 资产与写盘时间）。
    ///
    /// Windows 上建符号链接需要开发者模式/管理员，所以这里不落盘，只把真实归档逐条目喂给
    /// **解包期的同一套判定**（名字、类型、符号链接目标、改写），确认我们不会把合法 rootfs 拒掉。
    ///
    /// `$env:ANIMUS_LINUX_ROOTFS='…\debian-minimal-aarch64.tar.xz'; cargo test --lib -- --ignored --nocapture real_rootfs`
    #[test]
    #[ignore]
    fn scans_the_real_rootfs_archive() {
        let Ok(path) = std::env::var("ANIMUS_LINUX_ROOTFS") else {
            return;
        };
        let file = File::open(&path).unwrap();
        let reader = lzma_rust2::XzReader::new_mem_limit(file, false, 256 * 1024);
        let mut archive = tar::Archive::new(reader);
        let (mut entries, mut bytes, mut links, mut absolute_links) = (0u64, 0u64, 0u64, 0u64);
        let mut has = std::collections::HashSet::new();
        for entry in archive.entries().unwrap() {
            let entry = entry.unwrap();
            entries += 1;
            let segments = entry_segments(&entry.path_bytes()).unwrap_or_else(|e| {
                panic!("合法 rootfs 被名字规则拒掉: {e}");
            });
            let kind = entry.header().entry_type();
            match kind {
                tar::EntryType::Directory => {}
                tar::EntryType::Regular | tar::EntryType::Continuous => {
                    bytes += entry.header().size().unwrap_or(0);
                }
                tar::EntryType::Symlink => {
                    let target = entry.link_name_bytes().unwrap();
                    symlink_target_verdict(&segments, &target)
                        .unwrap_or_else(|e| panic!("合法符号链接被拒: {e}"));
                    if target.starts_with(b"/") {
                        absolute_links += 1;
                        relative_link_target(&segments, &target)
                            .unwrap_or_else(|e| panic!("绝对链接无法改写: {e}"));
                    }
                    links += 1;
                }
                other => panic!("发布归档里出现了不允许的条目类型: {other:?}"),
            }
            if !segments.is_empty() {
                has.insert(
                    segments
                        .iter()
                        .map(|s| s.to_string_lossy().into_owned())
                        .collect::<Vec<_>>()
                        .join("/"),
                );
            }
        }
        eprintln!(
            "rootfs: entries={entries} files_bytes={bytes} links={links} absolute_links={absolute_links}"
        );
        assert!(has.contains("usr/bin/bash"), "缺 usr/bin/bash");
        assert!(
            has.contains("usr/lib/ld-linux-aarch64.so.1"),
            "缺 glibc 解释器"
        );
        assert!(has.contains("etc/apt/sources.list"), "缺 apt sources");
        assert!(
            has.contains("bin") && has.contains("lib"),
            "merged-usr 链接缺失"
        );
    }
}
