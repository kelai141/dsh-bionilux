# HARDCODING — 配置参考与去硬编码说明

本文件是**运行契约**：DSH 插件据此调用 bionilux。所有取值都可用环境变量或 CLI 覆盖，
仓库内不硬编码任何宿主包名路径。

## 1. 为什么必须可配置

上游默认安装前缀写死为 `/data/data/com.termux/files/usr`。真实目标环境的前缀是
**`/data/data/com.dsharnessmobile.shell/files/usr`**（真机实测），包名完全不同。
本 fork 把前缀变成纯粹的输入，`src/` 内不再出现任何 `com.termux` 字面量。

## 2. 环境变量

### 2.1 路径与运行时

| 变量 | 含义 | 默认 |
|---|---|---|
| `BIONILUX_ROOTFS` | guest 的 `/`，物理位于此 | 未设 → 关闭 rootfs 语义（退化为上游行为） |
| `BIONILUX_PREFIX` | 宿主安装前缀（用于定位 glibc runtime 与 box64） | 空，回退读 `PREFIX`，再空 |
| `BIONILUX_RUNTIME_DIR` | 宿主 glibc 目录（`lib/`、`etc/`） | `$BIONILUX_PREFIX/glibc` |
| `BIONILUX_LOADER` | 显式指定 loader | 从 rootfs 内查找 |
| `BIONILUX_PRELOAD` | 显式指定 preload 库 | rootfs `/usr/lib/bionilux/` → 可执行文件同级 → runtime |
| `BIONILUX_BOX64` | 跨架构时的 box64 | `$BIONILUX_PREFIX/bionilux/box64-glibc` |

### 2.2 guest 身份与环境

| 变量 | 含义 | 默认 |
|---|---|---|
| `BIONILUX_GUEST_PATH` | guest `PATH` | Debian 标准 `/usr/local/sbin:…:/bin` |
| `BIONILUX_GUEST_HOME` | guest `HOME` | `/root` |
| `BIONILUX_GUEST_TMP` | guest `TMPDIR`/`TMP` | `/tmp` |
| `BIONILUX_GUEST_CWD` | 初始 guest 工作目录 | `/` |
| `BIONILUX_FAKE_ROOT` | 虚拟 uid/gid 0、chown/setgroups 变 no-op | 配置了 rootfs 时默认 **1** |
| `BIONILUX_LENIENT` | 缺失 guest 路径时回退宿主路径（**仅调试**） | `0` |
| `BIONILUX_CHDIR_TO_BINARY` | 先切到目标所在目录 | 未设 |
| `BIONILUX_DEBUG` | 打印映射/路由日志到 stderr | 未设 |

### 2.3 由 launcher 导出给 guest 进程（勿手工设置）

`BIONILUX_ROOTFS` `BIONILUX_PREFIX` `BIONILUX_RUNTIME_DIR` `BIONILUX_BOX64`
`BIONILUX_GUEST_PATH/HOME/TMP/CWD` `BIONILUX_FAKE_ROOT` `BIONILUX_LENIENT`
`BIONILUX_BINARY_PATH` `BIONILUX_TARGET_EXE`
`BIONILUX_GUEST_SESSION`

子进程靠这些值推导出与父进程一致的映射。

`BIONILUX_GUEST_SESSION=1` 标记已进入运行时；包含静态工具启动的子进程。
此时继承的 `BIONILUX_GUEST_CWD` 只作无法映射 cwd 时的默认值，嵌套调用 launcher
保持当前物理工作目录。首次宿主入口仍使用该环境变量指定初始目录；显式
`--guest-cwd` 在两种情况下都优先。

### 2.4 会被剥离、不会进入 guest 的宿主变量

`PREFIX`、`TERMUX_VERSION`、`TERMUX_APP_PID`、`TERMUX_MAIN_PACKAGE_FORMAT`、
`TERMUX_APK_RELEASE`、`LD_AUDIT`、`LD_DEBUG`、`LD_PROFILE`。

`LD_LIBRARY_PATH` **不剥不设**：guest 自己设的必须保留，loader 的搜索路径改为
用 `--library-path` 按次传递，避免把宿主物理路径灌进 Bionic 子进程。

该参数现在包含经映射的主程序 RPATH/RUNPATH、guest `LD_LIBRARY_PATH` 和默认库目录，
保留 RPATH → 环境 → RUNPATH 的优先级。仅处理主程序自己的动态标签，不能据此推断
所有间接依赖的搜索语义已经完整支持。未显式设置 `SSL_CERT_FILE` / `SSL_CERT_DIR` 时，
仅在 guest 证书文件/目录存在的情况下填入它们的物理路径。

`LOCPATH` 未指定且 guest `/usr/lib/locale` 存在时，导出其物理目录，让 glibc 能加载
Debian 随附的 `C.utf8` 等目录式 locale。只有 `locale-archive`、没有相应目录数据的
locale 仍需用 `localedef --no-archive` 生成；这不是强制把用户的 `LC_ALL=C` 改成 UTF-8。

## 3. 命令行

```
bionilux [选项] <命令> [参数...]

  --rootfs DIR         guest 文件系统根
  --guest-cwd DIR      初始 guest 工作目录
  --guest-path LIST    guest PATH（冒号分隔）
  --print-config       打印解析后的运行时身份并退出（健康检查用）
  -d, --debug          调试输出
  -n, --no-preload     不注入 preload（无子进程重路由、无路径映射）
```

**约定**：launcher 自己的选项必须在**命令之前**。命令之后的参数一律原样转发给目标，
因此 `bionilux grep -n foo` 里的 `-n` 属于 grep 而不是 `--no-preload`。
（上游在这一处有缺陷，`echo -n` / `grep -n` 会丢参数；本 fork 已修。）

## 4. 健康检查（插件的安装门槛）

`bionilux --print-config` 输出 `KEY=VALUE`，可直接解析：

```
ROOTFS=/data/.../files/linux/<id>/rootfs
ROOTFS_ENABLED=1
ROOTFS_LOADER=yes          # rootfs 内找到与宿主同架构的 loader
PRESENT_BIN_SH=yes         # /bin/sh 存在
PRESENT_USR_BIN_APT-GET=yes
PRESENT_USR_BIN_DPKG=yes
PRESENT_ETC_OS-RELEASE=yes
FAKE_ROOT=1
```

**只有 `ROOTFS_ENABLED=1` 且 `ROOTFS_LOADER=yes` 时才注册 `linux_bash`**，
否则不注册、也不破坏已有环境（见 CONTEXT.md 架构不变量）。

## 5. rootfs 安装流程（插件侧）

```bash
# 1. 解压到暂存目录，校验 manifest 里的 SHA-256
# 2. 处理 rootfs（必需：绝对符号链接、DNS、必需目录）
sh scripts/prepare-rootfs.sh --rootfs "$STAGE" --relative-links --dns "$DNS_SERVERS"
sh scripts/prepare-rootfs.sh --rootfs "$STAGE" --relative-links --verify    # 失败则不要启用
# 3. 原子 rename 到正式位置，再启用
```

暂存目录之后要 rename，必须使用 `--relative-links`；默认绝对模式仍保留，
但只能在最终物理位置准备，之后不能直接搬移。相对模式下 guest 的 readlink 会看到相对目标。
`--verify` 和 `--dry-run` 不修改文件或权限；准备失败则不得启用。

`--dns` 的取值必须来自**设备当前网络**（Android 无 `/etc/resolv.conf`），
详见 [STATUS.md](STATUS.md) §9 的设备验证记录；网络可达性仍需按设备检查。

## 6. 发行版与共享 Node.js

Linux Environment System 独立于 DSH Mobile APK 版本发布；安装器从版本化 GitHub Release manifest 获取两种插件及运行时资源的直接下载地址、大小和 SHA-256。所有大体积 rootfs、Node.js 和运行二进制只作为 Release 附件分发，不提交到 Git 或 Git LFS。

默认运行时为 Debian minimal。Bionilux launcher/preload 和 Debian rootfs 按运行时实例装配；glibc Node.js 作为应用级、按 ABI/版本划分的共享工具包安装一次，各 Linux rootfs 引用它，不在各 rootfs 内重复安装。宿主 DSH Core 的 Bionic Node 与此 Node 不同，不得互相冒充。

设置提供自动更新开关和手动检查更新。自动检查仅在记录的 DSH Mobile 安装版本发生变化后触发；开关启用、网络恢复、后台重启本身均不触发自动更新。手动检查不受此前版本是否变化限制，安装前仍由用户确认。

## 7. 卸载

```bash
rm -rf "$ROOTFS"          # 整个 Linux runtime 目录
# 宿主侧只额外有 preload 库与可执行文件，位于 BIONILUX_PREFIX 下
```
