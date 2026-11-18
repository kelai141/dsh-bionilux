# Linux runtime 0.12.0

## 修复与改进

- launcher 启动时为每个宿主直通目录在 rootfs 内补齐祖先目录（空目录），逐组件遍历路径的程序不再在中途遇到 `ENOENT`：共享 Node 直通到 `PREFIX` 之外的 App 目录时，`npm`/`npx` 也能正常解析自身模块（此前报 `ENOENT ... lstat '/data'`）。
- 空目录只补在 rootfs 内，挂载点本身仍是宿主直通，"缺失的 guest 路径不回退到宿主"的规矩不变。

## 升级说明

已安装的 Linux 运行时需要重新安装或修复一次，才会换上新 launcher；安装器继续按清单里的 sha256 校验资源，旧清单指向的内容不受影响。

## 安装前提与验证边界

仅面向 64 位 ARM64 / x86_64 引擎。现代 Android APK 必须携带与 Debian/glibc 配套的 native loader，并正确传递 nativeLibraryDir；现有 APK 的版本号本身不是兼容性证明。详见 [移动端兼容条件](docs/MOBILE_COMPATIBILITY.md)。

本运行时不是安全沙箱，Linux 虚拟 root 不是 Android root。实际设备、正式资产与 CI 验证结果以发布前审计记录为准；未验证组合不声称已支持。
