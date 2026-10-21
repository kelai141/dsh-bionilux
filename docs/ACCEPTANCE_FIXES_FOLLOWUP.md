# 非发布项续修与复测

日期：2026-10-21。基于 `b528a0a`；不执行 tag、资产发布或 APK 更新。
本页补充 [两轮问题台账](ACCEPTANCE_FIXES.md)，保留历史失败和原报告。
证据目录：`D:/dsh-bionilux-acceptance/bnx-20261020101206/fixes2/`。

## Ruby：2241 项全量通过

实际设备 x86_64 Debian / Ruby 3.3.8；通过 Android `run-as com.dsharnessmobile.shell` 启动。
`/proc/self/status` 记录四个实际 UID 均为 **10052**，SELinux 仍为此前的 Permissive。

15 项残留并非同一根因：

- 11 项来自上游测试对 `rspec-core` 检出目录名的依赖，原 `ruby-rspec-core` 不匹配正则，影响库遍历及内部回溯过滤。
- 1 项为 root 能读取 chmod 0000 文件造成的测试条件差异；应用 UID 复测产生正确拒绝访问。
- 2 项来自 ERB 6.0.7 的调用栈与该 RSpec 快照预期不同；隔离副本通过项目原生 `Gemfile-custom` 固定 ERB 4.0.3，未改断言。
- 1 项确认是运行时缺陷：`unsetenv_others` 的最小子进程环境被内部配置和默认值污染，现已在 preload 修复。

源码做法：最小 envp 没有 `BIONILUX_ROOTFS` 时记录显式提供的配置/default key；transport 仍交给 launcher。
preload constructor 缓存完整上下文后，移除应用未提供的 runtime/default 环境变量；后续 exec 从私有缓存恢复配置。
`TARGET_EXE` / session 标记也纳入缓存，proc 自身身份使用缓存读取，孙进程仍保留路径映射及 executable 身份。
显式 SSL/LOCPATH 和普通自定义环境值保留；分配失败时保留可运行状态。

此机制覆盖受钩子管理的动态 glibc 子进程，不声称静态/raw-syscall 程序获得同样的环境透明性；不是环境变量保密机制。

结果：

- 旧 preload、规范目录名和应用 UID：2241 examples / **3 failures** / 5 pending。
- 旧 preload、同一个 ERB 4.0.3 基线：2241 examples / **1 failure**，仅剩最小环境用例（`full-old-same-deps.log`）。
- 新 preload、ERB 4.0.3：2241 examples / **0 failures** / 5 pending，重复全量运行通过。
- 真实 74 个 Ruby 库源文件编译成 VM bytecode；第二次构建 **0 rebuilt / 74 reused**。
- 故意使一份 cache key 过期：**1 rebuilt / 73 reused**；真实 RSpec dry-run 执行通过。
- 实际应用 UID 下，Node/zod 和 Python 的空环境子进程、孙进程访问 guest 文件与 proc 身份回归通过（`clean-environment.sh`）。
- 上游 5 pending 原样保留，不算执行通过项。

复现入口：[ruby-rspec.sh](../tests/acceptance/polyglot/ruby-rspec.sh)。

```sh
# 在可写的隔离副本操作，目录末级必须为 rspec-core；不要覆盖原验收 checkout。
export BUNDLE_PATH=/root/polyglot/bundle2
cd /root/bn-fixes2/ruby/rspec-core
printf "gem 'erb', '= 4.0.3'\n" > Gemfile-custom
# 此设备只安装 x86_64 ffi；隔离副本 lock 去掉未安装的平台，避免 --local 要求其他 ABI。
bundle lock --remove-platform aarch64-linux-gnu aarch64-linux-musl arm-linux-gnu arm-linux-musl arm64-darwin ruby x86-linux-gnu x86-linux-musl x86_64-darwin x86_64-linux-musl --local
bundle update erb --local
export RSPEC_PROJECT="$PWD" EVIDENCE_DIR=/root/bn-fixes2/ruby/workflow
bash /path/to/tests/acceptance/polyglot/ruby-rspec.sh
```

Android 侧必须用实际 app UID 启动 launcher；guest fake-root 的 chown 是虚拟的，隔离副本的实际 owner 由宿主 Android `chown` 设置。
原项目 Git 跟踪的 source/test 没有修改；Gemfile-custom 与 lock 是隔离副本的依赖基线配置。
设备日志 `/root/bn-fixes2/ruby/{full-appuid,full-fixed,workflow}.log`。
## PHP / Composer：原项目依赖与 glob 修复

原 Monolog 项目缺少 ext-mongodb 引发依赖解算错误，其错误渲染又触发 Composer 上游 UTF-8 截断问题。
隔离解包 `php8.4-mongodb 2.0.0-1` 与 `libsnappy1v5 1.2.2-1` 到 `/root/php-mongodb-prefix`，
通过 PHP_INI_SCAN_DIR / LD_LIBRARY_PATH 引用；未升级系统、未改系统 PHP ini，也未忽略 platform requirements。
Composer 安装 76 包、check-platform-reqs、再次无变更安装均 exit 0。

续测定位出独立运行时缺陷：glibc glob/glob64 的隐藏目录/统计调用绕过原钩子，绝对 guest pattern 返回空。
新 `compat_glob.inc.c` 用 GLOB_ALTDIRFUNC 映射目录/stat 操作，保持 pattern 和结果为逻辑路径；
保留调用方自带 callbacks、DOOFFS、APPEND、NOCHECK、glob64 类型及错误回调。
34 项主机回归通过；设备绝对/相对模式匹配、NOCHECK 通过。

真实上游结果：

- MongoDB handler：3 tests / 6 assertions，1 项无外部服务器的预期 skip，exit 0。
- 原项目全量：1307 tests / **0 failures** / 24 optional-service skips / 9 deprecations，exit 0。
- 全量使用实际 app UID 10052；为满足上游“非 root 不可写 /”的假设，临时把 rootfs 根目录实际 owner 设为 root，完成后恢复原 owner。
- ADB root 的原样全量仍有 2 项预期权限差异失败；该失败日志保留，不能把非 root 条件下的结果冒充默认 root 环境全过。
- 未加载扩展的反证仍 exit 4；driver 即使 skip install/test，也会因缺扩展返回失败。

源码复现：[composer_mongodb.php](../tests/acceptance/composer_mongodb.php)。默认全量；任何请求阶段失败都返回非零。
显式 `--clean-fixtures` 只在已确认的隔离副本使用，保护 Git 跟踪文件且不遍历 symlink；正常测试不依靠手工清理掩盖 glob 故障。
完整证据：`fixes2/composer/RESULTS.md` 与其 `device-logs/`。
## 命名信号量：创建者被杀后的残留清理

`compat_python.inc.c` 在目录 flock 内回收可识别、属于真实 effective UID 的已死亡创建者临时对象。
新名字携带 PID 和进程 starttime，避免 PID 复用误判；fork 后缓存按 PID 更新。
初始化中使用独立 TEMP magic，完整初始化后原子发布；slot 保持原 48 字节 ABI，原 4 字节保留位记录最终名字 hash。
因此合法用户名称即使以 `.bn-sem-tmp-` 开头，也不会被当成垃圾；临时名不能等于请求的最终名。
扫描 fd 使用原子 CLOEXEC 复制，避免并发 exec 继承目录锁描述符。

校验 owner 用真实 UID，不能用 guest fake-root UID 或目录 owner；因此 root-owned 0777 目录下的 app UID 仍能回收自己的临时文件。
完整头校验 magic/version；保留外国 owner、活进程、未来 mtime、畸形名称、符号链接及未知协议版本。
旧协议没有 starttime/hash 的歧义对象保守保留，不承诺自动删除全部历史文件；扫描有界。

验证：x86 主机、AArch64/QEMU、Android x86_64 的三个创建中 SIGKILL 周期、并发等待、PID 复用及名称碰撞测试通过。
Android 另以实际 UID 10052 验证 root-owned 目录下的自有对象清理和外国 owner 保留；虚拟 stat 不作为真实 owner 证据。
QEMU 的 fork-child starttime 表现有限，该精确 token 在 x86 主机与 Android 验证。
证据：`fixes2/sem/FROZEN_REPORT.md`、`SHA256SUMS` 和分平台日志；整机断电恢复不在该结论内。
## Gradle / Swift：原缓存恢复与未重现项

详见 `fixes2/gradle-swift/FINDINGS.md`，22 份脚本及原始日志保留。

Gradle 使用原 `kotlin-kotlinpoet`、`env-jvm.sh`、Xmx1200m、`--no-daemon` 和同一 `/root/.gradle`：
配置/任务阶段共五次只中断测试自身 setsid 进程组，SIGTERM 返回 143、SIGKILL 返回 137；
五次均新建 launcher 会话恢复 exit 0（40～64 秒）。未删除缓存、未切换 GRADLE_USER_HOME。
另直接制造 settings.gradle.kts Kotlin 语法错误，exit 1；恢复原文件后使用原缓存 exit 0。
最终 clean-tree 的 cleanJvmTest/jvmTest：1011 tests / 40 skipped / 0 failures / 0 errors。
缓存从内容变更引起的编译增长到 503 MB / 241 files，后续稳定；项目源码 Git 状态干净。

Swift 6.0.3：130 次有界版本查询（顺序、管道、并发及测试期间）全 exit 0，检查无 swift 进程残留。
真实 swift-argument-parser build/test 通过，566 tests passed；对真实跟踪源文件的增量构建 exit 0，math 1 2 3 输出 6。

续测中 multiple producers 的根因是测试脚本错误 touch 了 `Sources/ArgumentParser/ParsableCommand.swift`，
真实文件在 `Parsable Types/` 子目录，因而新增同名零字节源文件。
同 SDK/设备、同 `.build` A/B：加入同名文件失败，移除后成功；非空同名仍失败，唯一 basename 的新文件成功。
保留失败数据库/日志，仅移除自己创建的未跟踪测试产物。未修改 Swift 或运行时来适配这个脚本错误。

debug.yaml 没有 physical-rootfs 工具路径，dladdr 的路径别名假设未获该故障证据支持，未盲目新增钩子。
历史 Gradle 单次缓存损坏和 37 分钟 Swift 挂起均未重现，原进程状态不在，**根因仍未证实**。
因此结论是已定义的中断恢复/重复执行工作流 PASS，不等于证明所有未来挂起/缓存错误已被消灭；JVM CPU workaround 仍需使用。
## 多轮恢复与性能核验

修复组合构建 S1（fixes2-bionilux4 + fixes2-preload-final.so）连续 20 次 launcher 会话退出/重入，
每轮 Python fork/spawn IPC、Node/zod、.NET C/C++ P/Invoke 三项 NUnit、Go/SQLite、Julia/JSON3、Dart args 292 项测试全部 exit 0。
每轮执行前后校验四份关键产物/锁文件 SHA-256，全部一致。
这是 launcher 会话重入，不是整机重启，也不是所有 19 种语言重新安装。

随后 S2（fixes2-preload-final2.so）增加目录扫描 fd 的原子 CLOEXEC 与会话归属标签的私有传播，
再复跑同样三轮，均通过；Node/Python 空环境子进程与孙进程也验证 API 不暴露内部标签、初始 proc environ 仍保留追踪标签。
每个构建保留独立源码副本、二进制与哈希，未覆盖原安装。

20 轮总计约 357 秒，单轮 12.890～26.646 秒；前期同时有其他真实项目验证，不把该区间当成隔离基准。
设备 MemAvailable 从 2,946,444 KB 到 3,032,836 KB，未观察到该窗口内的持续耗尽；不据此证明长期不存在泄漏。

另作五对交替次序的旧/新 preload 对照（各一次预热排除）：同一 launcher、Python IPC、Node/zod、.NET Interop、Go/SQLite。
全部 exit 0；旧版中位数 1.71 秒，新版 1.63 秒；峰值 RSS 最大值分别 52,160 / 52,320 KB。
这是小样本缓存工作负载，未观察到明显性能退化，不能推广成全部编译器或长期负载的性能保证。
证据：`fixes2/recovery20-results.json`、`benchmark-results.json`、`device/recovery20/`、`device/recovery-final2/`、`device/benchmark/`。
## Zig / Rust / C 与 BEAM

读取真实 manifest 后选定 Zig 0.17.0；zalgebra 最低要求 0.17.0，zig-clap 为 0.17.0-dev.1941+71115f0ab。
官方 x86_64 SDK 下载并核验 SHA-256；两份真实上游项目 `zig build test -j1` 均 exit 0。
旧 0.15.2/0.16.0 的 std API 错误日志保留，不能再把它们归为“Android 不支持 Zig”。

新增可复跑 [zig-beam fixture](../tests/acceptance/polyglot/zig-beam/README.md)：
Zig→C、Zig→Rust→C、C→Zig/Rust，以及 BEAM NIF 动态加载并调用相同库。
真实构建 exit 0；C 联合校验 9/9、Zig 1/1、NIF EUnit 2 项通过。
负例 EUnit 返回 2；外层 driver 显式要求编译 0、正例 0、负例 2。
用错误模块替换正例、强制构建失败，分别使整体 driver 返回非零，未吞掉失败。
BN4 入口重跑联合构建/运行/测试也通过。

Cowboy 原 rebar3 profile 没有编译 test/handlers，改用上游 erlang.mk 编译真实测试树。
先验证 TEST_DEPS= 的 EUnit 176 项；随后补齐匹配 OTP 27 的 SSL src 头文件，ct_helper 编译 exit 0。
Go h2spec 工具还受静态 Go 的默认 DNS/路径限制影响：使用物理 cache/tmp、物理 CA 路径及临时 localhost HTTPS CONNECT 转发，
真实下载并校验六项 Go 模块，h2spec 构建和 --help exit 0。
最后普通 `make eunit`（没有 TEST_DEPS=）exit 0，176 tests passed，日志无旧依赖错误。
CT 测试套件没有执行，不算 CT PASS。

CONNECT 只转发 TLS，未替换证书或改系统 DNS；临时 adb reverse 与主机监听器已在验证后移除。
静态 Zig 使用相对路径或授权物理路径；静态 Go 默认 DNS/直接 syscall 的虚拟化仍不在 preload 能力范围，不能把配置适配说成已拦截原始 syscall。
证据：`fixes2/zig-beam/FIXES2_ZIG_BEAM.md`、`previous-failures/`、`bn4/`、`h2spec-proxy-build.log`、`cowboy-eunit-proxy.log`。

## 管理器：归属、热重载与脱离进程组的子进程

同一 Node realm 内，一个规范化 dataDir 仅允许一个存活 manager；重新 import 模块和已有目录的 symlink 别名也不能绕过。
成功 dispose 后释放归属，失败时保留；旧 disposed 对象再次调用不会清理替代 owner 的进程。
插件 apply 注册服务失败时清理自己创建的 manager 和监听器；借入的 host manager 不会被销毁。

仅用进程组不能回收已经 setsid 的后台进程，因此新增 ProcessScope：按规范目录生成稳定标签，
扫描相同真实 UID 且初始 proc environ 含精确标签的进程，比较 PID starttime 后发送 TERM/KILL。
生命周期变更同时等待原进程组与 scope 排空，再允许 rootfs 更新；不是每条命令退出都清理共享构建守护进程。
标签经过 preload 私有上下文保留，使受管理的动态 glibc env -i/孙进程也能被识别；新 host 可识别旧 host 崩溃遗留进程。

真实 Android app UID 10052、host Node 24.18.0 / guest Node 20.19.2、BN4/S2 fixture：
前台终止早于替换 extraction、后台回收、dispose、重新加载模块的重复 owner 拒绝，以及旧 host SIGKILL 后接管清理均已有实测。
下载内容为合成 fixture，guest 确实通过修复的 launcher 运行；不把它当正式资产下载或 APK 集成验收。
原未实现 scope 时 setsid 存活的日志保留在 fixes2/manager；当前证据在 fixes2/manager-scope。

设备整组已有 11 项观测通过。后续一次整组重跑在立即读取 env-i grandchild 的 proc environ 时失败，
事后该 PID 标签仍正确；脚本加入有界等待 exec 就绪后，主线程独立复跑 escaped stage：
普通 daemon PID 616 与 env-i daemon PID 630 均被回收，无标签对照 PID 631 存活，三项通过。
保留整组失败的 before-poll-fix JSON 与最终 targeted JSON，不用后者覆盖历史记录。

scope 只覆盖可读且带标签的合作进程；未知不可读、外部无标签 PTY、故意丢弃上下文及 raw syscall 绕过不在保证内。
标签不是秘密或安全边界。跨 Node 进程/worker/隔离 realm 的并发 writer 不由这张进程内 owner 表串行化。
不能外部替换存活 manager 的目录或 symlink 目标；SELinux Enforcing 下的 proc 可见性尚未实测。

## 回归与剩余边界

Rust fmt/clippy 与 76 项测试通过；两插件 WSL 测试最终 85/85、零跳过。
原生 runtime、make、路径、身份、libc syscall、IPC、glob、动态库、UBSan 与 AArch64/QEMU 回归通过；
最新 scope 环境传播及 IPC 扫描 fd 的 CLOEXEC 改动另有针对性复跑，glob 的 QEMU 34 项也全部通过。
复现脚本位于 tests/acceptance，测试日志在 fixes2/host-logs；各阶段使用独立构建，源码及二进制哈希分别留存。

发布与 APK 集成按用户要求暂缓。ARM64 真机、Enforcing、整机重启及完整 19 语言/105 分钟压力窗口尚未重新验收。
MuMu JVM CPU workaround、静态程序直接 syscall 的路径/DNS 边界仍存在。
历史单次 Gradle 缓存损坏和 Swift 挂起没有足够状态证明根因，继续列为未确认，而不是虚报已彻底修复。
