# Linux runtime 0.10.7

## 修复与改进

- 修复 arm64 真机上 Linux 环境在「准备 rootfs」阶段以 `Bad system call` 失败的问题。
  根因：Android 对 targetSdk >= 29 的应用进程使用 untrusted_app 的 seccomp 白名单，
  默认动作是 TRAP —— 白名单之外的系统调用会被内核用 SIGSYS 杀掉。bionic 从不调用
  `set_robust_list`(99) 与 `rseq`(293)，两者因此不在白名单里；而 glibc 的 loader 在
  为第一个线程做 TLS 初始化时会发出它们（`init_tls` → `__tls_init_tp`，早于任何重定位，
  也早于任何 LD_PRELOAD 代码），libc 在每创建一个线程时还会再发一次 `set_robust_list`。
- 在 APK 内承担链接器角色的 glibc loader 现在于构建期打补丁：这两处 `svc #0` 改写为
  `movn x0, #37`（即 `-ENOSYS`），不再进入内核。实测这两个是启动阶段仅有的被拦调用。
- 安装（prepare）阶段会用同一规则给 guest 的 `libc.so.6` 打补丁。glibc 里这两处调用
  不止一处（新线程创建也会用到），而 rootfs 里的 libc 来自 Debian 包、构建期碰不到，
  所以放在设备侧执行：按摘要记账、可重复执行（幂等）；重新安装/更新 Linux 环境时会重打。
  匹配不到预期指令时直接报错，不静默放过。
- 为什么不能靠 LD_PRELOAD 里的 SIGSYS 处理器：这两个调用发生在 loader 的 TLS 初始化里，
  比预载库的 ifunc resolver 和构造函数都早，预载库还没跑第一行代码，进程就已经被杀
  （真机与本地 glibc 2.39/2.41 均复现）。新线程那一条更绕不过：`start_thread` 在调用前
  把全部信号 block，而 SIGSYS 被 block 时内核把处置复位为默认并直接杀线程。
- 局限：静态链接的 guest 不经过这两处调用点，未覆盖；x86_64 guest 不打补丁
  （Android 模拟器镜像允许这两个调用，且指令编码不同）。应用域还拦着 `unshare`/
  `keyctl`/`setgroups` 等其它调用，本补丁不覆盖它们，踩到仍是 `Bad system call`。

## 真机证据（vivo V2425A / Android 17 / targetSdk 34）

- 未修复：`ld.so --version` 正常（不进入 libc 初始化），但任何 glibc 程序（rootfs 的
  `/usr/bin/true`、`dpkg-divert`）都在初始化阶段被 SIGSYS 杀死。ptrace 抓到的最后一条
  系统调用是 `set_robust_list`(99)；把它改成 `-ENOSYS` 后，下一条被拦的是 `rseq`(293)。
- 把这两个调用现场改成 `-ENOSYS` 后，`/usr/bin/true` 与 `dpkg-divert --listpackage`
  均正常退出 0。
- 应用 seccomp 白名单纯枚举（0..469）实测：99 与 293 均返回 SIGSYS。
- 补丁后 qemu-aarch64 `-strace` 显示 guest 不再发出这两个调用；改动集中在三处
  `svc`（libc 两处 99、一处 293）与 loader 两处。
- 待补：真机整条安装链（下载 / 校验 / 准备 / 激活）需要一份带新 loader 的 APK 才能复验。

## 验证

- `node --test packages/linux-runtime/test/libc-seccomp-patch.test.mjs`：7 项通过
  （调用点识别、改写、幂等、libc 变更后重打、匹配不到时拒绝、非 arm64 / 缺 libc 跳过）。
- 构建期：`scripts/patch-android-glibc.mjs` 在 CI 里对 `bionilux-loader-*.so` 执行，
  找不到调用点即构建失败；AArch64 之外的产物跳过。
- 现有回归：`node --test packages/linux-runtime/test/*.test.mjs`（见 CI 输出）。