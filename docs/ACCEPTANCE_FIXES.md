# 两轮验收问题与源码修复台账

日期：2026-10-21。原始基线：`4865754bd9e3e030e62a60793b418a6a0f643b14`。
修复分支：`codex/acceptance-runtime-fixes`。两轮原始报告保留，修复后的结果不覆盖历史失败。

覆盖 D-01～D-10、P-01～P-14 共 24 个编号，包括重复根因。PASS 只对应注明的复现或工作流，不代表原先 19 种语言、压力窗口和插件链路全部重新验收。

## 环境与证据

- MuMu 实例 5，ADB `127.0.0.1:16544`；Android 15 / SDK 35，x86_64 用户态，Debian 13，4 vCPU / 4 GB。
- 沿用此前 ADB root / SELinux Permissive 环境，不能替代普通应用 UID、Enforcing 或 ARM64 手机验收。
- 主机：Windows + WSL Ubuntu；AArch64 编译/QEMU 单列，不作为 Android ARM64 实测。
- 第一轮报告：`D:/dsh-bionilux-acceptance/bnx-20261020101206/artifacts/ACCEPTANCE_REPORT.md`。
- 第二轮报告：`D:/dsh-bionilux-acceptance/bnx-20261020101206/polyglot/artifacts/ACCEPTANCE_REPORT_POLYGLOT.md`。
- 新脚本与证据：`D:/dsh-bionilux-acceptance/bnx-20261020101206/fixes/`；设备原件 `/root/bn-fixes/`。
- 补丁使用独立 `fixes-bionilux*`、`fixes-preload*.so` 与 `BIONILUX_PRELOAD`，未覆盖原安装的 launcher/preload，未重装 rootfs。

## 24 项结果

| 编号 | 问题及实际归属 | 源码处理 | 新结果及范围 |
|---|---|---|---|
| D-01 | Node/libuv 通过 libc syscall(statx) 绕过已有钩子 | 新增 ABI 汇编入口及选定文件调用映射 | **PASS**：guest stat、npm 安装 46 包、zod 加载；内联汇编仍不覆盖 |
| D-02 | venv/shutil 的 xattr 路径未映射 | 补齐八个路径形式 xattr 入口，保留 errno | **PASS**：默认 venv、复制与属性回归；无吞错/monkeypatch |
| D-03 | glibc sem_open/shm_open 内部访问宿主 /dev/shm | 文件支持的共享 mmap/sem_t、目录锁、引用计数及原子发布 | **PASS**：fork/spawn Pool、Lock、SharedMemory；另有创建中 SIGKILL 恢复测试 |
| D-04 | 显式 loader 目标/库路径未翻译 | 识别 rootfs loader，映射参数；实际运行程序仍注入 preload | **PASS**：设备 ldd/--list；主机 --verify、真实运行、身份回归 |
| D-05 | 主 ELF 绝对 RPATH/RUNPATH 与 guest LD_LIBRARY_PATH 未映射 | 读取动态标签，展开 ORIGIN，按原优先级传物理库路径 | **PASS（主 ELF）**：真实 .so 与优先级回归；非完整传递依赖语义 |
| D-06 | 内核 uname 与 native bridge 用户态 ABI 不同 | uname.machine 报 guest ABI，管理器校验 ELF | **PASS**：设备返回 x86_64；其他内核字段保留 |
| D-07 | 无 x86 发布资产、默认架构选择及 APK 插件登记缺口 | 双架构矩阵/manifest、按 ABI 默认选择、拒绝错架构 | **BLOCKED（外部发布/集成）**：源码已补；未发布 tag、未改 APK 仓库、未宣称端到端安装完成 |
| D-08 | 相对链接中的 .. 可越过物理根 | 准备脚本与 symlink/symlinkat 归一化越界目标 | **PASS（对应复现）**：根级、深目录、dirfd；链接链/竞态/绕过钩子仍非内核隔离 |
| D-09 | 静态/内联汇编 syscall 不经过 preload | 明确与 libc syscall 函数的区别 | **UNSUPPORTED**：架构边界，未伪称解决 |
| D-10 | 子进程残留及 rootfs 更新竞态 | 进程组 TERM→KILL，确认退出才允许变更，可撤销排空 | **PASS（主机管理器）/ UNTESTED（实际插件设备链）**：独立 ADB PTY、自行 setsid 不保证回收 |
| P-01 | CGO 嵌套 launcher 重置 cwd、目录落入 shadow tree | session 标记、嵌套 cwd、逐组件 host-path 修正 | **PASS（有条件）**：go-sqlite3 全量/增量；物理 workspace/cache/tmp、CC 桥及官方 go test -exec |
| P-02 | Julia 路径、库搜索、显式符号及 DEEPBIND | syscall、旧 stat、dlsym、DEEPBIND、loader 路径修正 | **PASS（记录环境）**：JSON3 instantiate/test/run/增量；737 PASS、3 Broken；保留 SDK depot，配置随附 linker 库路径 |
| P-03 | Dart snapshot/TLS/symlink executable 路径 | syscall、CA 默认值、规范 executable 身份 | **PASS**：pub get 50 依赖、args 292 项测试及增量 |
| P-04 | .NET 误认 loader、旧 stat ABI 和显式 libc 查询 | 自身 exe 的 realpath/readlink、__xstat 家族、dlsym | **PASS**：SDK 8.0.426、NuGet、MSBuild、3 项 NUnit C/C++ P/Invoke、增量 |
| P-05 | MuMu 默认 JVM AVX/JIT SIGILL | 不把模拟器 CPU workaround 强加给所有设备 | **UNSUPPORTED（该默认 CPU 配置）**：仍需原报告 JVM/GLIBC_TUNABLES 设置 |
| P-06 | uname 误导安装器下载 arm64 | 同 D-06，以 ABI/ELF 选择及校验 | **PASS（架构返回/校验）**：未重下载所有安装器 |
| P-07 | Java/Swift/Julia 非标准库路径 | 同 D-05，补显式查询与 DEEPBIND | **PASS（已测布局）**：Julia/.NET 等；间接依赖自身动态标签仍未完整映射 |
| P-08 | cp -RpL 的 llistxattr(logical path) ENOENT | 同 D-02 | **PASS**：原 Cowboy src 目录与 xattr 保留；不再删 -p |
| P-09 | prove 挂起，原报告未根因化 | shebang 报最终解释器，避免 $^X 指向 prove 后递归启动 | **PASS**：身份旧/新对照；Mojolicious 109 文件、4183 项全过（含上游 skip） |
| P-10 | Ruby 32 项失败被笼统归为 locale | guest LOCPATH 默认值，保留 LC_ALL，恢复正确 BUNDLE_PATH | **FAIL（残留 15）**：2241 examples，15 failures，5 pending；余下 backtrace/权限等未全部归因 |
| P-11 | Composer PCRE 遮蔽依赖错误 | 抓取 subject，确证上游按字节截断俄文 UTF-8；未改 Composer | **BLOCKED（原项目）/ PASS（干净消费项目）**：原项目缺 ext-mongodb；Composer require Monolog 及运行成功 |
| P-12 | 单次 Gradle settings cache 损坏 | 管理层补安全停止/禁止未排空切换 | **UNTESTED（该缓存故障新复现）**：不通过删缓存宣称修复，原错误尚不能归因运行时 |
| P-13 | swift --version 单次残留 | 同 D-10 的有界终止和失败关闭 | **UNTESTED（原挂起根因）**：math 正常运行不等于旧挂起根因已清除 |
| P-14 | Android 重启丢失 adb root | 操作步骤，不更改 adbd 安全/启动设置 | **UNSUPPORTED（自动保留 root）**：非 rootfs 数据丢失或 bionilux 缺陷 |

## 补充定位

1. `.NET` 首先需要 `realpath(/proc/self/exe)`，只修 readlink 不够。旧 stat ABI 的版本参数必须原样转交，不能伪造成功。
2. `dlsym` 从 libc 或其他 DSO 的依赖查出 libc 实现时，普通 PLT 拦截不够。仅替换本 preload 确有实现的 libc 定义；自定义 DSO 同名符号保留。RTLD_NEXT/DEFAULT 汇编尾转发保留原调用者。
3. Julia libcurl 用 `RTLD_DEEPBIND` 绕过 DNS。启用 rootfs 时去掉此标志；无 rootfs 不变。这是明确的符号优先级取舍，不承诺原 DEEPBIND 隔离语义。
4. SDK symlink 入口需要规范真实 executable；shebang 需要最终解释器。设备旧 launcher 执行 perl-self 得到 `$^X=/root/bn-fixes/perl-self`，新版本得到 `/usr/bin/perl`。
5. GNU mkdir -p 的组件遍历必须进入授权 host-path，否则会在 rootfs/data 下创建同名工作区，静态 Go 随后无法看到。
6. 信号量完整初始化后才原子发布最终名字，避免被杀死的创建者毒化后续打开。文件 IPC 不具备 tmpfs 的容量或整机重启清空特性。

## 修改范围与回归

最终验证：Rust 76/76；两插件 WSL 72/72（无跳过），Windows 的 POSIX 专项单列跳过。
原生、FORTIFY、UBSan、Make、loader、路径、IPC 故障恢复及 AArch64/QEMU 回归通过。
Android 最终构建连续三次退出/重新启动 launcher 会话，每轮复跑六种开发链路并校验四份产物/锁文件 SHA-256，均通过；这是运行时会话重启，不是整机重启。
Android 信号量 sem_init 中途 SIGKILL 后，同名对象由后继成功创建并取得值 7，日志 `sem-device-recovery.log`。
故障注入可留下一份未发布临时 inode，本次取证后清理；不承诺被杀进程自动清除全部临时文件。

主要源码：preload 三个文件、ELF/launcher、rootfs 准备脚本、runtime/bootstrap 两个插件及 CI/Release 工作流。插件新增实际 ELF 头校验、会话退出确认、失败安装清理、manager 所有权与双架构默认选择。

glibc Linux 主机验证命令：

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo build
bash tests/identity_compat.sh
bash tests/syscall_compat.sh
bash tests/python_compat.sh
bash tests/host_paths.sh
bash tests/preload_paths.sh
bash tests/sharedlib.sh
BIONILUX_TEST_LAUNCHER="$PWD/target/debug/bionilux" bash tests/runtime.sh
BIONILUX_TEST_LAUNCHER="$PWD/target/debug/bionilux" bash tests/make.sh
bash tests/ubsan.sh
bash tests/prepare_rootfs.sh
bash tests/aarch64.sh
node --test packages/linux-bootstrap/test/*.test.mjs packages/linux-runtime/test/*.test.mjs
```

identity 另用 AArch64 编译器/QEMU 验证 ABI。WSL `/mnt/d` 未启用 Unix permission metadata，prepare_rootfs 的权限断言在 Linux 文件系统副本执行，没有放宽 755/1777 断言。

设备入口：

```sh
export BIONILUX_RUNTIME_DIR="$APP/files/bnrt"
export BIONILUX_PRELOAD="$PATCH/preload.so"
"$PATCH/bionilux" --rootfs "$APP/files/bnrt/rootfs" --host-path "$APP" --guest-cwd / /bin/bash "$TEST_SCRIPT"
```

实际参数、退出码与输出在 fixes 脚本/日志。Go 已测命令为 `CC="$BN /usr/bin/gcc" go test -exec "$BN" ./...`，缓存/tmp/workspace 显式为物理路径。Julia 使用 `JULIA_DEPOT_PATH=/root/polyglot/julia-depot:` 和 `LD_LIBRARY_PATH=/opt/julia-1.11.5/lib/julia`；末尾 depot 分隔符保留 SDK 默认 depot。删除该默认路径曾触发额外 stdlib 冷编译，日志保留。

## 勘误与未覆盖

- 第一轮 20 条生命周期中有 4 条 plugin_reload UNSUPPORTED，不能写 20/20 PASS。
- Swift 原 566 项测试已过；独立 demo 的 -lArgumentParser 失败是未生成对应共享库的测试方式问题。现用真实 math executable 得到 42。
- Zig 版本/API 不匹配保留 BLOCKED；“必须 0.17-dev”证据不足，不能认定 Android 不支持。Rust+Zig+C 未补成 PASS。
- BEAM 原日志明确 EUnit 2 pass、ExUnit 3/0，不降级已有证据；未来脚本应把 eunit:test 失败 atom 显式变成非零。Cowboy 单语言 eunit 的 handler 模块布局仍是独立问题。
- C# 原 Mono 与本次 .NET 测试引用 NuGet 库，不等于编译 Newtonsoft 仓库源码。
- 未重做 105 分钟压力窗口、完整 20 轮生命周期、ARM64 手机、Enforcing/应用 UID 或实际 APK 发布验收，不据此给出新的无条件生产可靠性结论。
- Ruby 残留失败、JVM CPU workaround、Gradle 缓存、独立 PTY 及主动脱离进程组有明确残留边界。
