# Linux runtime 0.10.1

## 修复与改进

- 修复真机上 prepare-rootfs.sh 无法执行宿主工具的问题。此前脚本交给子进程的环境由
  白名单过滤，既没有 `LD_LIBRARY_PATH` 也没有 `PREFIX`，而 Android 引擎进程不保证
  提供这两个变量；脚本在 `set -eu` 下要么因 Termux 二进制加载失败（bionic 报成
  "Permission denied"），要么因 `PREFIX: parameter not set` 直接中止，导致 arm64
  真机上 Linux 环境恒定安装失败。
- 宿主侧工具环境改由 `dataDir` 推导 Termux 布局，下发
  `LD_LIBRARY_PATH` / `PREFIX` / `PATH` / `HOME` / `TMPDIR`，并在解析路径中保留
  APK 的 `nativeLibraryDir`。
- 修正一条把上述缺陷当成预期行为的用例：它先设置 `process.env.LD_LIBRARY_PATH` 再
  断言被透传，而真机上该变量不保证存在。现在清空该变量后断言库路径仍由 `dataDir`
  推导，回退本修复即变红。
