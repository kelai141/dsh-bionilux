# CONTEXT — 领域模型

本文档定义本项目（bionilux fork）中的术语、边界与不变量。
改代码前先读这里；改术语前先改这里。

## 1. 系统全景

```
dsh-mobile-apk (Android app, Bionic)
│
├── DSH Core / Node.js / Cordis         ← 始终跑在 Android Bionic 上
│
└── Linux Runtime Plugin (Cordis, 可选)
    │
    ├── Runtime Manager                 ← 下载/安装/启用/卸载/快照（dsh 侧）
    │
    ├── Linux Tool Provider
    │   └── linux_bash (PTY/Session)    ← dsh 侧
    │
    └── Runtime Backend                 ← 本仓库
        └── bionilux (Rust launcher, Bionic)
            ├── launcher                src/main.rs, src/launcher/*
            ├── rootfs 路径语义层        src/launcher/rootfs.rs
            └── preload hook (glibc)    src/preload/hooks.c
                    │
                    ▼
              Debian Minimal rootfs
              (/usr/bin/bash, glibc, apt, dpkg …)
```

## 2. 术语

| 术语 | 含义 | 不要混淆 |
|------|------|----------|
| **host** | Android 设备本体：Bionic libc、`/data/data/<pkg>/files/...`、SELinux | 不是 guest |
| **guest** | Debian 用户空间。一切 `/usr`、`/bin`、`/etc`、`/var` 语义都在这里 | 不是 host |
| **rootfs** | guest 的 `/`，物理位于 `<data-dir>/linux/<runtime-id>/rootfs` | 不是宿主 `/` |
| **PREFIX** | 保留概念：上游指 Termux 安装前缀。本 fork 中**默认为空**，全部改为 rootfs 相对 | 不要写死 `/data/data/com.termux/...` |
| **data-dir** | 本组件的私有数据目录（如 `files/linux`），放 rootfs、快照、暂存 | 不是 DSH Core 数据 |
| **launcher** | `bionilux` Rust 二进制，跑在 Bionic 上，负责 ELF 判定与 exec | 不是 loader |
| **loader** | glibc 的 `ld-linux-*.so.1`，来自 rootfs | 不是 launcher |
| **preload** | `libbionilux_preload.so`，注入 guest 进程的 glibc hook | 不是 loader |
| **rewrite** | 把 guest 路径重写成 host 上真实可访问的路径 | 不是 symlink |
| **guest-fail** | guest 语义下的失败（ENOENT 等），不得回退到 host 路径 | 不是 fallback |
| **backend** | 可选执行后端：本 fork（bionilux）或 PRoot | 可替换 |

## 3. 路径语义（核心不变量）

这是整个 fork 的核心。规则只有三条，但必须处处成立：

1. **绝对路径 `/x` → `<rootfs>/x`。**
   当且仅当 `<rootfs>/x` 存在时改写；不存在时**按 guest 语义失败**，
   绝不静默回退到 host 的 `/x`。
2. **相对路径按 guest cwd 解析。** guest cwd 必须由 launcher 显式维护，
   不能依赖宿主进程的 cwd。
3. **`*at()` 相对路径按 guest dirfd 解析。** dirfd 指向 rootfs 内的目录时，
   相对路径在其下解析；dirfd 是 guest 传进来的任意 fd 时，内核已经用真实路径打开了它，
   不需要额外处理。

### 反例（必须避免）

- `open("/usr/share/foo")` 落到 host 的 `/usr/share/foo` → **违约**。
- `stat("/etc/os-release")` 返回 Termux 的 `/etc` 内容 → **违约**。
- `chdir("/")` 之后 `getcwd()` 返回 host 根 → **违约**。
- 找不到 `/usr/bin/python3` 时回退到 `$PREFIX/bin/python3` → **违约**。

### 已知边界（设计取舍，不是 bug）

- `LD_PRELOAD` 只能覆盖走 libc 的动态链接 glibc 程序。
  静态二进制、直接 syscall、secure-exec 场景可能绕过。见 GOALS.md 的验收门槛。
- `/proc`、`/dev/*` 在 Android 无 Root 环境下无法完整虚拟化，按白名单转译。
- `execveat(dirfd, relative)` 上游已知绕过 hook。

## 4. 架构不变量

| 不变量 | 含义 |
|--------|------|
| **Cordis 只管接入** | 插件负责能力接入与生命周期，不参与路径语义 |
| **后端可替换** | 换 backend 不改变 `linux_bash` 的接口与快照格式 |
| **DSH 数据边界** | 默认直通路径包含推导出的 App 私有目录；集成方须审查 HOST_PATHS，不能把 rootfs 当作 DSH Core 数据的安全隔离边界 |
| **失败不降级** | 健康检查失败时不注册 `linux_bash`，也不破坏已有 PRoot 环境 |
| **不混用编译链** | Bionic 与 glibc 的工具链不混用；launcher 用 bionic 编译，preload 用 glibc 编译 |

## 5. 权限模型（引用，不在本仓库实现）

| DSH 权限模式 | `linux_bash` |
|--------------|--------------|
| read-only | 禁止 |
| workspace-write | 禁止 |
| danger-full-access | 允许 |

> RootFS 的用途是**软件包环境隔离**，不是内核级安全沙箱。快照用于状态恢复，不是安全边界。
