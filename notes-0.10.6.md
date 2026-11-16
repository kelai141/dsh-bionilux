# Linux runtime 0.10.6

## 修复与改进

- 修复 arm64 真机上 Linux 环境安装的最后一道阻塞：准备阶段的 guest 命令会以
  `execve failed: EACCES` 失败。guest 程序是 glibc 二进制，其动态链接器位于 rootfs 内，
  而应用数据目录中的文件不能被直接执行（targetSdk >= 29）。现在准备阶段也会把原生库
  目录告知 launcher，改由 APK 原生库目录中的可执行副本承担链接器角色。
- 这是同一根因的第三处修复（前两处分别在 0.10.2 与 0.10.5），三者的失败文案完全相同，
  都是 `Permission denied`。

## 配套要求

- 需要 APK 侧把 glibc loader 打进 `nativeLibraryDir`。缺少它时安装仍会失败，且错误
  信息会明确指向 `rootfs/lib/ld-linux-*.so`。

## 验证

- `packages/linux-runtime` 全量：141 项，124 pass / 17 skip / 0 fail
- 真机（V2425A / arm64）：launcher 在设置原生库目录后改取该目录副本，不再 EACCES
