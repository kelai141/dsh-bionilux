# bionilux — DSH Mobile 的 Linux 运行时

> English version: [`README.en.md`](README.en.md).

**这是 DSH Mobile 的 Linux 运行时。** 它在一个 Android 应用进程里承载完整的 Debian
用户空间：真实的 `apt`/`dpkg`、可用的 DNS 与 TLS、原生速度的 glibc 执行，并且不使用
PRoot。它是 DSH Mobile 的一个*组件*，由 Cordis 插件驱动——不是独立的 Termux 工具。

本仓库是 [`theonuverse/bionilux`](https://github.com/theonuverse/bionilux) 的 fork。上游解决的是
「在 Termux 上运行一个 glibc 二进制」；本 fork 解决的是「成为某个 Android 应用的 Linux
运行时」：guest 是一个带有自己路径语义的 `rootfs`，启动器不含任何写死的宿主路径，应用
必须访问的 Android 目录是**配置**，不是常量。

> **定义。** bionilux 运行的是 *guest* 的用户空间，不是宿主的。guest 给出的路径只在它
> 自己的 rootfs 内解析，解析不到就是不存在；同名的宿主文件系统**永远不会**作为兜底。

已在真机 arm64（vivo V2425A，Android 16 / SDK 36，SELinux enforcing，无 root）与
x86_64 模拟器上验证。

## 相比上游，本 fork 增加了什么

| 领域 | 变化 |
|------|------|
| 路径语义 | rootfs 就是 guest 的 `/`。guest 路径不会落到宿主；`..` 在 guest 根处被截断；`getcwd()`/`readlink()` 返回 guest 路径。 |
| 无写死路径 | 每个 Termux 路径都由安装前缀推导。同一份构建既能从 Termux 的 `$PREFIX` 运行，也能从应用私有的 `files/` 目录运行。 |
| Android 目录 | `/sdcard`、`/storage/emulated/0` 与宿主应用的私有数据目录都能以它们**自己的名字**访问，由 `--host-path` / `BIONILUX_HOST_PATHS` 配置。 |
| DNS | 由 preload 从 *guest* 的 `/etc/resolv.conf` 与 `/etc/hosts` 解析。否则 glibc 会去读宿主的文件、读不到，于是每次解析都以 `EAI_AGAIN` 失败。 |
| 包管理 | `apt-get update` 与 `apt-get install` 可用，包括 debconf 前端、`dpkg` 的 postinst 脚本与 `ca-certificates`。 |
| 身份 | guest 被告知它是 root，并且前后自洽：`getuid()` 与 `stat()` 的结论一致，因此 `git`、`dpkg`、`tar` 都接受自己的工作树。 |
| 原生命令行 | `--print-config`、`--rootfs`、`--guest-cwd`、`--host-path`、`--no-android-paths`。 |

## 快速开始

运行时安装在一个由应用持有的前缀下；`PREFIX/files/...` 布局是**推导**出来的，不是假定
的。

```bash
# 一次性 rootfs 准备：绝对符号链接、resolver、目录。
sh scripts/prepare-rootfs.sh --rootfs /path/to/rootfs --dns "$DNS_SERVERS"

export BIONILUX_ROOTFS=/path/to/rootfs
bionilux /bin/bash -c 'cat /etc/os-release; apt-get update'

# 健康检查：只有这里给出肯定答案时，插件才注册该工具。
bionilux --print-config | grep -E 'ROOTFS_ENABLED|ROOTFS_LOADER'
```

访问设备的 Android 一侧：

```bash
bionilux --rootfs "$R" --host-path /data/local/tmp /bin/sh -c 'ls /data/local/tmp'
bionilux --rootfs "$R" --no-android-paths /bin/sh -c 'ls /sdcard'   # 被拒绝
```

当运行时安装在应用自己的 `files/` 目录内时，guest 会以该私有目录**自身的绝对 Android
路径**看到它——于是应用与 guest 共享同一份数据：

```bash
# 运行时位于 /data/data/<pkg>/files/bnrt，PREFIX=/data/data/<pkg>/files/usr
bionilux --rootfs "$R" --print-config | grep HOST_PATHS
#   HOST_PATHS=/data/data/<pkg>
bionilux --rootfs "$R" /bin/sh -c 'cat /data/data/<pkg>/files/app-state.json'
```

## 实验性 DSH Mobile 插件与更新

Linux 环境是一套**实验性的、可选择启用的系统，由我们自己的内部插件构成**。引导插件随
应用分发、放在内置（hard）插件目录里；它**默认不启用**——存在 ≠ 启用——而且它也**不挂
进 Cordis profile**，因此只有在用户显式启用该系统时宿主才会加载它（见 `docs/DECISIONS.md`
D-014）。运行时插件与其它一切一样，来自 Release。安装 APK 更新或发布新的 Linux Release
都不会启用它们，也不会把用户关掉的重新打开。轻量的引导插件与运行时插件分别以版本钉定
的 GitHub Release 资产发布，由 `linux-release.json` 描述；在用户启用系统并显式确认安装
运行时之后，`linux_bash` 才会被注册。

Linux 系统有它自己的版本生命周期。手动检查更新始终可用；自动检查只对**已经启用**的
Linux 系统生效，且必须满足「已安装的 DSH Mobile 应用版本发生变化」并且用户把它的自动
更新选项打开。手动检查在未经显式确认的情况下**永远不会**安装更新。

Bionilux、rootfs 与一份共享的 glibc Node.js 包都以带校验和的 Release 资产发布，不作为
提交进仓库的源码，也不使用 Git LFS。应用级只安装一份 Linux Node，供各 rootfs 实例共用；
宿主的 Bionic Node 与 Termux Bash 保持不变。rootfs 提供的是 Debian/glibc **运行环境
支持**，不是安全沙箱。

## guest 路径语义

* 只有绝对路径会被重写；已经在 rootfs 内的路径原样保留，因此不会被重复加前缀。
* `/proc`、`/sys`、`/dev` 仍归宿主内核。例外是 `/dev/shm`，因为 POSIX 共享内存必须落在
  某个可写的位置。
* 不含 `..` 的相对路径直接透传：物理工作目录本来就在 rootfs 内。含 `..` 的相对路径先对
  *guest* 工作目录解析，`..` 在 guest 根处被截断。
* 在 rootfs 中不存在的路径**同样**会被重写，这样内核会报 `ENOENT`，而不是悄悄暴露宿主
  里同名的那个文件。

配置项，按 `--print-config` 的顺序：

| 选项 | 环境变量 | 作用 |
|------|----------|------|
| `--rootfs DIR` | `BIONILUX_ROOTFS` | guest 的 `/` |
| `--guest-cwd DIR` | `BIONILUX_GUEST_CWD` | guest 的初始工作目录 |
| `--host-path DIR` | `BIONILUX_HOST_PATHS` | guest 能以自身路径访问的宿主目录（可重复） |
| `--no-android-paths` | `BIONILUX_ANDROID_PATHS=0` | 去掉 `/sdcard` 默认值 |
| `--print-config` | — | 解析后的配置，用于健康检查 |

## 真机验证

| 能力 | 证据 |
|------|------|
| Debian rootfs 可运行 | Debian 13 trixie，glibc 2.41，`HOST_ARCH=Aarch64` |
| DNS | `getent hosts deb.debian.org` -> `146.75.114.132` |
| HTTPS + 信任库 | `curl -sS -o /dev/null -w '%{http_code}' https://github.com` -> `200`，未用 `GIT_SSL_NO_VERIFY` |
| 包管理 | `apt-get update` 拉取 9.7 MB；`build-essential`、`git`、`ca-certificates`、`strace` 安装成功 |
| 工具链 | gcc 14.2.0，git 2.47.3，make 4.4.1 |
| 版本控制 | 在全新 clone 上 `git clone`、`git status`、`git log` |
| 遍历 | 对 guest 的 `/etc`、`/usr`、`/var` 与一个 clone 下来的仓库执行 `find` |
| Android 公共存储 | guest 写入 `/sdcard/bn-visible.txt`，宿主可读 |
| Android 私有数据 | guest 以原生路径读写应用自己的 `files/` 目录 |

## 已知限制

其中一些是 Android 平台事实，另一些是用 `LD_PRELOAD`（而不是内核沙箱）实现这件事本身
固有的。它们被如实记录，而不是被粉饰。

**平台限制（运行时无法修复）。**

* **硬链接被拒绝**，且是全设备范围的——包括应用自己的私有目录内。`dpkg` 的备份步骤需要
  `link()`，因此 preload 回退为复制。
* **`mkfifo()` 对 shell UID 以 `EACCES` 失败**（SELinux），所以 GNU make 无法创建它默认的
  FIFO jobserver。它也不需要：`make -jN --jobserver-style=pipe` 改用管道即可工作——已在
  一次内核构建中用 `-j8` 验证。
* **`ldconfig` 是静态链接的**，任何 preload 都无法映射它；它会往 Android 只读的 `/etc` 写。
  `prepare-rootfs.sh` **不会**安装替身；配置流程需要它的软件包必须由集成方显式处理。
* **静态二进制**完全在 `LD_PRELOAD` 触及范围之外。

全新 rootfs 在使用前还需要先跑 `scripts/prepare-rootfs.sh`：它重写 Debian rootfs 里那些
**绝对**符号链接，否则内核会相对*宿主*根去解析——这正是 `/usr/bin/awk` 与
`/usr/bin/which` 能工作的前提。

**`LD_PRELOAD` 只能触及公开的、跨 PLT 的函数。** glibc 的*内部*调用不会离开这个库，因此
libc 为自己做的一切都相对宿主解析。每一类都在程序实际调用的公开 API 处被处理：

| 内部被绕过 | 由谁处理 |
|------------|----------|
| `/etc/resolv.conf`、`/etc/hosts` | `getaddrinfo`、`gethostbyname*` 用 guest 的文件解析 |
| `/etc/passwd`、`/etc/group` | `getpwnam*`、`getpwuid*`、`getgrnam*`、`getgrgid*` |
| `system`/`popen` 用的 `/bin/sh` | `system`、`popen`、`pclose` |
| `mkstemp` 自己的 `open` | `mkstemp`/`mkostemp`/`mkstemps` 及其 `64` 拼写 |
| 对某个路径的 `dlopen` | `dlopen`——语言运行时的扩展模块、PAM、NSS 插件 |
| `readlink("/proc/self/fd/N")` | 内部使用物理路径，对外呈现 guest 路径 |

**preload 触及不到的地方。** 唯一需要额外思路的一类是 `eaccess()`/`euidaccess()`：glibc
在用户态实现它——它不能用 `access(2)` 系统调用（那测的是真实 uid），于是自己去 `stat()`
该路径并比较 mode 位。那次 stat 是 preload 看不见的内部调用，所以一个绝对的 guest 路径
落到了宿主上，报出 `ENOENT`。GNU make 用 `eaccess()` 判断配方命令是否可执行，当它说不
可执行时，make 报「No such file or directory」并**在没有 fork 的情况下**放弃——对失败配
方做系统调用跟踪，里面连一个 `clone`、`fork` 或 `execve` 都没有。命令经过 shell 的配方
不受影响，因此坏的只是 make 的直执行路径。把路径映射过去就修好了。

## 工作原理

Termux 用的是 Android 的 Bionic libc。已发布的 Linux 二进制链接的是 glibc，并期待一个
Android 上并不存在的动态链接器（`/lib/ld-linux-aarch64.so.1`），于是内核以 `ENOENT` 拒绝
它们。解决办法是手工调用 glibc 加载器，并让每个子进程都留在同一条路径上：

```
kernel reads ELF header -> PT_INTERP missing -> ENOENT
bionilux: execve(ld-linux-aarch64.so.1, --argv0 target target ..., env)
          with LD_PRELOAD=<our hooks> and a rootfs-aware environment
```

两个组件：

* **启动器**——一个为 Bionic 构建的小型 Rust 二进制。它读目标的 ELF 头、决定解释器，然后
  调用 `execve()`。
* **preload 库**——为 glibc 构建，注入每个 guest 进程。它重定向 `exec*`/`posix_spawn*` 使
  子进程留在 guest 内，给 guest 它自己的文件系统视图，并实现那些被绕过的 libc 内部调用
  所对应的公开 API。

没有 `ptrace`，没有沙箱：guest 代码以原生速度运行。代价是文件系统对 libc 的内部使用不做
虚拟化——这就是上面那张表存在的原因。

## 架构

```
        bionilux <target>
              │
       read ELF header
              │
   ┌──────────┼───────────┬─────────────┐
   ▼          ▼           ▼             ▼
bionic     aarch64     x86_64        shebang
/static    glibc       glibc         script
   │          │           │             │
   │          ▼           ▼             │
   │      ld-linux   ld-linux +         │
   │      +preload   box64 +preload     │
   ▼          ▼           ▼             ▼
execve    target      x86_64 bin    interpreter
native    runs        runs under    resolved and
                      box64         rerun
```

配置了 rootfs 时，启动器还会把目标映射进 rootfs，并在加载器运行前导出 guest 环境。

## preload 钩子

构造函数用 `dlsym(RTLD_NEXT, ...)` 解析符号，并钩住：

**进程**

| 钩子 | 行为 |
|------|------|
| `execve`、`execv`、`execvp`、`execl*`、`fexecve`、`execveat` | 经启动器重定向；裸名字相对 **guest 的** `PATH` 解析，永远不用宿主的 |
| `posix_spawn`、`posix_spawnp` | 同样的重定向，进入启动器 |
| `system`、`popen`、`pclose` | 以剥掉 `LD_PRELOAD` 的方式经启动器跑 `/bin/sh -c` |
| `fork`、`vfork` | 保持 guest 环境自洽 |

**文件系统**

| 钩子 | 行为 |
|------|------|
| `open*`、`openat*`、`creat`、`creat64` | 把 guest 路径映射进 rootfs |
| `stat`、`lstat`、`stat64`、`fstatat*`、`statx`、`fstat`、`fstat64` | 映射路径，然后对属主报告 guest 自己的身份 |
| `opendir`、`scandir`、`scandirat`、`readdir` | 映射路径 |
| `mkdir`、`rmdir`、`unlink`、`unlinkat`、`remove`、`rename*`、`link`、`linkat`、`symlink*` | 映射路径；平台拒绝硬链接时 `link`/`linkat` 改为复制 |
| `chmod`、`fchmod`、`fchmodat`、`chown`、`lchown`、`fchownat`、`utime*`、`utimensat`、`lutimes`、`truncate`、`truncate64` | 映射路径 |
| `mkstemp`、`mkostemp`、`mkstemps`、`mkostemps`（含 `64` 拼写）、`mkdtemp`、`mkfifo*`、`mknod*` | 映射模板并在此处创建，因为 libc 内部的 `open`/`mkdir` 不会被拦截 |
| `readlink`、`readlinkat`、`realpath`、`__realpath_chk`、`getcwd`、`chdir`、`fchdir` | 呈现 guest 的路径视图 |
| `statfs`、`statfs64`、`statvfs`、`statvfs64` | 映射路径 |
| `dlopen` | 映射绝对库路径 |
| `access`、`faccessat` | 映射路径 |

**身份与名字解析**

| 钩子 | 行为 |
|------|------|
| `getuid`、`geteuid`、`getgid`、`getegid`、`getres*id` | 报告 guest 的（虚拟）身份 |
| `setuid`、`setgid`、`setre*id`、`setres*id`、`setgroups` | 记录请求并返回成功；宿主 uid 无法改变 |
| `getpwnam*`、`getpwuid*`、`getgrnam*`、`getgrgid*` | 读 guest 的 `/etc/passwd` 与 `/etc/group` |
| `getaddrinfo`、`gethostbyname*` | 用 guest 的 resolver 查询，再把数值地址交回 glibc，让它保留自己的服务与套接字语义 |

`va_list` 在 aarch64 上是结构体而不是数组——`execl*` 的转换取指针，好让调用方的位置往前
推进。这个 bug 只在硬件上才暴露出来。

## 从源码构建

启动器是 Rust，preload 是 C。在 Windows 上 MSVC 宿主没有 `link.exe`，所以用自带的 GNU
宿主工具链加上 Android NDK 链接器来构建：

```bash
# 启动器（aarch64 Android）
cargo +stable-x86_64-pc-windows-gnu build --release --target aarch64-linux-android
#   CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=<ndk>/aarch64-linux-android24-clang.cmd

# preload（aarch64 glibc）
aarch64-linux-gnu-gcc -shared -fPIC -O2 -o libbionilux_preload.so src/preload/hooks.c \
    -Wl,--dynamic-linker=/lib/ld-linux-aarch64.so.1 \
    -Wl,-rpath,/usr/lib/aarch64-linux-gnu
```

`bash tests/preload_paths.sh` 会构建 preload 并在宿主 glibc 上跑它，因此路径层无需设备
即可测试。

## 测试

宿主侧回归无需设备即可运行。Android 验收与交互行为需要它们各自的设备验证；宿主结果**不
等于** Android 兼容性。

* **单元测试**——`cargo test`。请在 Unix 宿主上运行；本项目使用仅 Unix 的 API。
* **宿主钩子测试**——`bash tests/preload_paths.sh`。在合成 rootfs 中检查 guest 路径映射、
  文件缺失行为、逻辑根遍历与 `_FORTIFY_SOURCE` 一致性。这些检查**不构成**安全沙箱。
* **验收**——`bash tests/acceptance.sh` 驱动一个真实的 Debian rootfs 走完运行时，也可以用
  PRoot 跑同样的用例做对照，或经 `adb` 对设备运行。
* **设备上**——`bash tests/smoke.sh` 跑上游的 exec/shebang 用例，外加上面那张能力表。

额外的宿主侧回归：`bash tests/runtime.sh` 覆盖运行时 API、并发子进程、加固边界、隔离回环
DNS 与原生 PTY 作业控制；`bash tests/ubsan.sh` 用不恢复的 UBSan 检查重跑一遍。
`bash tests/make.sh` 覆盖直接/经 shell/递归的 Make 配方、管道 jobserver 的 fd 与真实的 C
编译器/链接器链路。`cargo build` 之后，为 runtime/Make 套件设置
`BIONILUX_TEST_LAUNCHER="$PWD/target/debug/bionilux"`，即可使用真实的 Rust 启动器而非仅供
测试的原生启动器。`bash tests/aarch64.sh` 交叉编译并在显式 QEMU 下运行 AArch64 glibc 探针；
它**不**验证 Android/Bionic/SELinux。

关于准备工作与配套脚本，`bash tests/prepare_rootfs.sh` 检查准备流程、只读模式、重定位、
安装器参数处理以及基准失败/JSON 输出。后者需要 Python 3 与宿主 C 编译器；
`tests/bench.sh --json` 同样需要 Python 3。安装器默认从 `kelai141/dsh-bionilux` 取
release；用 `BIONILUX_REPO`/`BIONILUX_VERSION` 选择其它已发布的 release。

诊断工具特意留在仓库里，因为每一个都破解过一个真实 bug：`tests/helpers/netprobe.c`
（网卡、resolver 状态、原始 UDP/TCP DNS）、`tests/helpers/ftsprobe.c`（`fts(3)`——因而也是
`find` 与 `rm -rf`——在 preload 后面看到什么）、`tests/helpers/privprobe.c`（那个否定结论：
`GLIBC_PRIVATE` 符号无法被插桩）。

## 文档

| 文档 | 内容 |
|------|------|
| [`docs/README.md`](docs/README.md) | 导览与阅读顺序 |
| [`docs/HARDCODING.md`](docs/HARDCODING.md) | 运行时契约：什么可以写死，什么必须推导 |
| [`docs/ROOTFS.md`](docs/ROOTFS.md) | 路径映射规则，以及它们覆盖不到的情况 |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | 这个运行时为什么这样构建 |
| [`docs/STATUS.md`](docs/STATUS.md) | 什么能用、什么不能，以及证据 |
| [`docs/REVIEW.md`](docs/REVIEW.md) | 评审修复、可复现检查、剩余限制与 Android 设备清单 |
| [`docs/PERF.md`](docs/PERF.md) | 相对 PRoot 的实测数字 |

## 与上游的关系

上游 bionilux 在 Termux 上跑一个 glibc 二进制；本 fork 在应用内跑一个 Debian guest。ELF
分类、加载器调用与子进程重定向的设计来自上游。而关于 guest 文件系统、guest 身份、名字解
析、包管理与 Android 路径访问的一切都是本 fork 的，并且是在真机上而非桌面上测试的。

经 `box64-glibc` 的 `x86_64` 支持继承自上游且未改动；本 fork 不依赖它。
