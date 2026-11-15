# Linux runtime 0.10.2

## 修复与改进

- 修复 arm64 真机上 Linux 环境恒定安装失败。失败发生在宿主侧准备脚本
  `prepare-rootfs.sh` 第 63 行，报 `files/usr/bin/find: Permission denied`。
  真因不是文件权限，也不是动态链接：targetSdk 34 的应用只能 `execve` APK 的
  `nativeLibraryDir`，数据目录里的 ELF 会被内核直接拒绝，脚本根本走不到加载器。
  渲染成 "Permission denied" 的这句文案让此前两版修复都偏向了 loader 方向。
- 宿主侧准备脚本改回使用 Android 系统自带的 toybox 工具（`find`/`sed`/`readlink` 等），
  不再把 Termux 的 `bin` 目录放进 `PATH`：那些二进制在这个应用里无法执行，
  放进去只会把本来可用的系统命令替换成跑不起来的。
- 移除上一版对 `LD_LIBRARY_PATH` 的注入。变量值本身没错，但对这条执行路径没有意义，
  留着会继续把人引向 loader。
- 用例改为断言真正的不变量：`PATH` 中任何一项都不得指向 Termux bin 目录。
  回退本修复即变红（已验）。

## 说明

- 0.10.1 的修复方向是错的，请以本版为准。
