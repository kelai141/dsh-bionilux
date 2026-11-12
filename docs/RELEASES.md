# RELEASES — 独立发布与分发

本文件说明 Linux 环境系统如何发布、如何保证下载完整性，以及为什么它不进入 Git/LFS。

## 1. 为什么不用 Git / LFS 分发

发布物包含 Bionilux 二进制、glibc preload、Debian minimal rootfs 与 glibc Node.js，
体积在百 MB 量级，且每次发布都会变化。它们**全部**作为 GitHub Release 附件发布：

* 不提交到 Git 仓库；
* 不使用 Git LFS（避免仓库膨胀、克隆成本与 LFS 配额耗尽）；
* `.github/workflows/ci.yml` 与 `release.yml` 都会扫描并拒绝：
  被跟踪的二进制/归档后缀（`.so`、`.tar.xz`、`.deb`、`.apk`、`.tgz` …）、
  任何 Git LFS 指针文件，以及 `.gitattributes` 里的 `filter=lfs` 规则。

## 2. 发布物清单

发布操作通过 `release.yml` 的 workflow_dispatch 显式选择 `vX.Y.Z` 与源码提交；workflow 只创建草稿，公开正式版需要核验后单独提升。以下为 ARM64 的稳定文件名，x86_64 同时使用对应 `x86_64` / Node `x64` 名称：

| 文件 | 内容 |
|------|------|
| `bionilux-aarch64` | Android/Bionic launcher |
| `libbionilux_preload-aarch64.so` | glibc preload hook |
| `bionilux-backend-aarch64.tar.xz` | 运行时后端打包（`bin/`、`lib/`、`scripts/`） |
| `debian-minimal-aarch64.tar.xz` | Debian 13 trixie minimal rootfs（不含 Node.js） |
| `node-glibc-v<版本>-linux-arm64.tar.xz` | 官方 Node.js 的 glibc arm64 包（应用级共享一份） |
| `linux-release.json` | 发布清单（安装器唯一读取入口） |

当前发布构建覆盖 **arm64 与 x64**，并提供各自 `bionilux-loader-<架构>.so`、`BUILD_INFO.json` 与 `SHA256SUMS`。这代表资产架构，不代表所有对应设备已经验证。ARM64 的实际 16 KB 页设备与正式壳的一键安装需要独立验收，见 [移动端兼容条件](MOBILE_COMPATIBILITY.md)。不得以“同源代码”或静态 ELF 检查推断全设备兼容。

## 3. 清单（`linux-release.json`）

```json
{
  "schemaVersion": 1,
  "version": "0.5.0",
  "minMobileVersion": "0.14.0",
  "runtimes": [{
    "id": "debian-minimal",
    "label": "Debian 13 (trixie) for ARM64",
    "architecture": "arm64",
    "backend": "bionilux",
    "backendAsset": { "url": "...", "sha256": "...", "size": 0, "unpackedSize": 0 },
    "rootfsAsset":  { "url": "...", "sha256": "...", "size": 0, "unpackedSize": 0 },
    "nodeAsset":    { "url": "...", "sha256": "...", "size": 0, "unpackedSize": 0 }
  }]
}
```

* `url` 一律是**版本化**的 GitHub Release 下载地址（`/releases/download/<tag>/<file>`），
  不使用 `latest` 重定向作为完整性依据。
* `sha256` 与 `size` 由发布流程对**实际产物**计算，`unpackedSize` 由解包统计得到。
* `version` 是 **Linux 系统版本**，与消费方应用版本各自独立演进。
* `minMobileVersion` 声明最低可用应用版本；低于它时安装与自动更新都会被拒绝。

清单由 `scripts/build_release_manifest.py` 单一实现生成并校验（CI 与发布流程同一个脚本），
避免两套模型漂移。

## 4. 完整性

安装链路每一层都校验：

1. **清单读取**：只接受 HTTPS 的 GitHub 域名；`latest` 通过 API 取到具体 tag 后，
   要求清单走该 tag 的版本化地址，并用 GitHub 提供的 `size`/`digest` 元数据比对。
2. **资源下载**：无论由宿主 `downloadAsset` 还是内置 fetch 完成，下载后一律重新计算
   SHA-256 与字节数，不符即删除并失败。
3. **解包**：只调用注入的安全解包器，拒绝绝对路径、`..` 与逃逸符号链接；
   不调用 `tar`/shell。
4. **后端包**：`bionilux-backend-<arch>.tar.xz` 只允许普通文件、目录与符号链接；
   拒绝绝对路径、`..`、硬链接、块/字符设备与 FIFO/socket。
5. **安装后**：Bionilux 的健康检查（rootfs 关键文件、launcher/preload、共享 Node）通过，
   才会原子切换 `active.json`。

## 5. 更新策略

本仓库只发布版本化资产，不实现自动更新：是否检查、何时安装、如何回滚由消费方应用
（acp-agent-ui 的 Rust 安装器）决定。已安装运行时与发布资产的版本对应关系由
`linux-release.json` 与 Release tag 表达，降级与重装语义由消费方保证。

## 6. 本地复现

```bash
# 清单生成与发布资产契约（CI 与发布流程都会跑）
python3 tests/test_release_workflows.py -v
python3 scripts/build_release_manifest.py target/release-assets <owner/repo> <tag> <version> <min-mobile> <node-version>
```

## 7. 已知缺口

* 只构建并发布 arm64；x86_64 未验证、未发布。
* Debian rootfs 由 `debootstrap` 构建，未固定镜像快照哈希（依赖 Debian 主镜像的稳定编号）。
* 真机端到端安装（含宿主的 `isInjected` 与 guest DNS）尚未完成验收。
