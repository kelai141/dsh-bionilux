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

标签 `vX.Y.Z` 触发 `release.yml`，发布以下**稳定文件名**：

| 文件 | 内容 |
|------|------|
| `linux-bootstrap-plugin.tar.xz` | 引导插件（`packages/linux-bootstrap`，npm pack 产物） |
| `linux-runtime-plugin.tar.xz` | 运行时插件（`packages/linux-runtime`，npm pack 产物） |
| `bionilux-aarch64` | Android/Bionic launcher |
| `libbionilux_preload-aarch64.so` | glibc preload hook |
| `bionilux-backend-aarch64.tar.xz` | 运行时后端打包（`bin/`、`lib/`、`scripts/`） |
| `debian-minimal-aarch64.tar.xz` | Debian 13 trixie minimal rootfs（不含 Node.js） |
| `node-glibc-v<版本>-linux-arm64.tar.xz` | 官方 Node.js 的 glibc arm64 包（应用级共享一份） |
| `linux-release.json` | 发布清单（安装器唯一读取入口） |

当前只发布 **arm64**（真机验证过的架构）。x64 需要单独构建与验证后才可加入矩阵，
不得以“同源代码”推断兼容。

## 3. 清单（`linux-release.json`）

```json
{
  "schemaVersion": 1,
  "version": "0.5.0",
  "minMobileVersion": "0.14.0",
  "plugins": {
    "bootstrap": { "url": "...", "sha256": "...", "size": 0, "unpackedSize": 0, "pluginReleaseUrl": "..." },
    "runtime":   { "url": "...", "sha256": "...", "size": 0, "unpackedSize": 0, "pluginReleaseUrl": "..." }
  },
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
* `pluginReleaseUrl` 是给人看的 Release 页面地址，安装界面据此提供两个插件的下载页链接。
* `version` 是 **Linux 系统版本**，与 DSH Mobile 应用版本、与插件包版本各自独立演进。
* `minMobileVersion` 声明最低可用应用版本；低于它时安装与自动更新都会被拒绝。

清单由 `packages/linux-runtime/modules/manifest.js` 与
`packages/linux-bootstrap/src/manifest.js` **两个校验器同时校验**（发布时与 CI 各跑一遍），
防止两侧模型漂移。

## 4. 完整性

安装链路每一层都校验：

1. **清单读取**：只接受 HTTPS 的 GitHub 域名；`latest` 通过 API 取到具体 tag 后，
   要求清单走该 tag 的版本化地址，并用 GitHub 提供的 `size`/`digest` 元数据比对。
2. **资源下载**：无论由宿主 `downloadAsset` 还是内置 fetch 完成，下载后一律重新计算
   SHA-256 与字节数，不符即删除并失败。
3. **解包**：只调用注入的安全解包器，拒绝绝对路径、`..` 与逃逸符号链接；
   不调用 `tar`/shell。
4. **插件包**：校验 `package.json` 名称与入口文件，且入口必须是包内普通文件。
5. **安装后**：Bionilux 的健康检查（rootfs 关键文件、launcher/preload、共享 Node）通过，
   才会原子切换 `active.json`。

## 5. 更新策略（独立于应用发布）

* 自动更新**默认关闭**，由用户在设置中开启。
* 开启后，仅当**已启用**的 Linux 环境记录的 DSH Mobile 应用版本与当前版本不同时，
  才检查一次更新（每个应用版本最多一次）。
* 手动检查随时可用，且**不会**自动安装：它只报告 `updateAvailable`，由用户确认安装。
* 降级被拒绝；相同版本必须走“重新安装”。
* 发布新 Linux 版本、发布新 APK、切换开关、恢复网络都不会重新注入或启用插件。

## 6. 本地复现

```bash
# 两个插件包的测试（CI 与发布流程都会跑）
node --test packages/linux-bootstrap/test/*.test.mjs packages/linux-runtime/test/*.test.mjs

# 清单双校验（发布流程同样执行）
node --input-type=module -e '
  import { validateManifest } from "./packages/linux-runtime/modules/manifest.js";
  import { validateManifestShape } from "./packages/linux-bootstrap/src/manifest.js";
  const m = JSON.parse(await (await import("node:fs/promises")).readFile("linux-release.json", "utf8"));
  validateManifest(m); validateManifestShape(m, process.env.TAG);
'
```

## 7. 已知缺口

* 只构建并发布 arm64；x86_64 未验证、未发布。
* Debian rootfs 由 `debootstrap` 构建，未固定镜像快照哈希（依赖 Debian 主镜像的稳定编号）。
* 真机端到端安装（含宿主的 `isInjected` 与 guest DNS）尚未完成验收。
