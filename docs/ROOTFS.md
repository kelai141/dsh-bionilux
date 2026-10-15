# ROOTFS — 路径语义层设计

本文件是本 fork 的核心设计文档。改路径相关代码前必读。

## 1. 为什么不只是"加前缀"

上游只把 `/etc/*` 拼上 `$GLIBC` 前缀。这对 Debian 是不够的：

| 场景 | 单纯加前缀的结果 |
|------|------------------|
| `open("/usr/share/zoneinfo/UTC")` | 落到宿主 `/usr/share/...`，Android 上不存在 → guest 里"文件消失" |
| `stat("/usr/lib/x86_64-linux-gnu")` | 同上 |
| `chdir("/")` + `getcwd()` | 返回宿主根，不是 guest `/` |
| `which("bash")` 用宿主 PATH | 找到 Termux 的 bash（Bionic），不是 guest 的 bash（glibc） |
| `#!/usr/bin/env python3` | `env` 被 redirect 到 `$PREFIX/bin/env`，跳出 guest |
| `access("/etc/passwd", R_OK)` | 命中宿主，返回错误结果 |

所以需要的是一层**统一的映射规则**，并且是**双向**的（可逆）。

## 2. 映射规则（单一事实来源）

```
map(guest_path) -> host_path

绝对路径 "/x"  →  <rootfs>/x            （无论存在与否，一律映射）
相对路径 "x"   →  由 guest cwd / dirfd 决定（见 §4）
```

**不存在时不回退**——这是本 fork 与上游最根本的差别：

```rust
// src/launcher/rootfs.rs
pub fn physical(&self, logical: &str) -> PathBuf {
    ...
    let physical = join_root(root, &normalize(logical));
    if self.lenient && !physical.exists() { return PathBuf::from(logical); }  // 仅调试
    physical                       // 缺失时仍返回 rootfs 内路径 → 内核报 ENOENT
}
```

这样做的理由：回退到宿主路径是**静默的错误答案**，比报错更危险。见 [DECISIONS.md](DECISIONS.md) D-001。

## 3. 反向映射（host → guest）

guest 程序会在输出里看到物理路径。必须把物理路径还原成逻辑路径：

```
unmap("/data/data/<pkg>/files/linux/<id>/rootfs/usr/bin/bash") -> "/usr/bin/bash"
```

使用场景：

- `getcwd()` / `PWD` / shell 的 `pwd` 内建。
- `readlink("/proc/self/exe")`（已由 preload 用 `BIONILUX_TARGET_EXE` 处理，改为逻辑路径）。
- 错误消息里的路径（`bionilux: /usr/bin/foo: not found`）。
- 传给子进程的 argv[0]。

## 4. dirfd 语义

| 情况 | 处理 |
|------|------|
| `openat(AT_FDCWD, "/x")` | 按绝对路径映射 |
| `openat(AT_FDCWD, "x")` | 按 guest cwd 映射 → `map(join(guest_cwd, "x"))` |
| `openat(fd, "x")`，fd 指向 guest 内目录 | 内核已持有真实路径，**不需要改写** |
| `openat(fd, "/x")` | 路径是绝对路径，fd 被忽略 → 按绝对路径映射 |
| `execveat(fd, "", AT_EMPTY_PATH)` | 用 `/proc/self/fd/N` 解析后递归处理 |

关键洞察：**只要 guest cwd 本身是物理路径，相对路径就是安全的。**
所以 launcher 必须保证初始 cwd 已经是 `map(guest_cwd)`。

> 本 fork 的做法：launcher `chdir()` 到 `map(guest_cwd)`，
> 并在 `BIONILUX_GUEST_CWD` 中记录逻辑值供 `getcwd()` 还原。

## 5. 符号链接

| 场景 | 结果 |
|---|---|
| 相对 symlink（`../lib/foo`） | 在 rootfs 内相对解析，**天然正确** |
| `readlink()` 返回值 | preload 做反映射，guest 看到**逻辑路径** |
| guest **运行时新建**的绝对 symlink | `symlink()` 把目标改写为物理路径，`readlink` 映射回来 → guest 仍看到逻辑目标 |
| rootfs **预置**的绝对 symlink | ⚠️ 内核按真实根解析 → **会读到宿主文件**。必须安装期处理 |

实测证据：Debian minimal rootfs 内有 **49 个**绝对符号链接（如
`/etc/localtime -> /usr/share/zoneinfo/Etc/UTC`）。未处理时 guest 内 `cat /etc/localtime`
读到的**是宿主的文件**；用 `scripts/prepare-rootfs.sh` 处理后，读到 guest 的、且
`readlink` 返回正确的逻辑路径。

处理方式（D-006）：

```bash
sh scripts/prepare-rootfs.sh --rootfs DIR              # 改写为 rootfs 内绝对路径（默认，保真 guest 语义）
sh scripts/prepare-rootfs.sh --rootfs DIR --relative-links   # 改写为相对路径（可搬移，但 guest 看到相对目标）
sh scripts/prepare-rootfs.sh --rootfs DIR --verify      # 安装门槛：仍有外指链接则失败
```

默认绝对模式保留原有行为：链接绑定当前 rootfs 的物理位置。
准备后还要移动/原子 rename 的暂存树应使用 `--relative-links`；此选项也会转换
当前树内已准备的绝对链接。根目录下的链接使用零层 `..`，避免指向 rootfs 外。

> 为什么不在运行时补救：`open("/usr/lib/os-release")` 经映射后由**内核**去解析链接目标，
> 用户态 hook 看不到这一步。`openat2(RESOLVE_IN_ROOT)` 能让内核在 rootfs 内解析（D-003），
> 但需要设备内核支持且会改变已验证的语义，故暂不采用。

## 6. 平台特殊路径

| 路径 | 处理 |
|------|------|
| `/proc` | 不映射（宿主内核真实信息）。`/proc/self/exe` 单独用 `BIONILUX_TARGET_EXE` 修正为逻辑路径 |
| `/dev/null`, `/dev/urandom`, `/dev/zero`, `/dev/tty` | 不映射，直接用宿主（Android 有） |
| `/dev/shm` | **例外**：映射进 rootfs。Android 没有 tmpfs shm，只有这样才能让 POSIX shm 工作 |
| `/tmp` | 映射到 rootfs 内 `/tmp` |
| `/sys` | 不映射 |
| DNS | 安装方提供 guest resolver 配置，并按设备验证，见 §6.1 |
| CA 证书 | 从 rootfs 推导；不再写死宿主路径 |

### 6.1 DNS（按设备验证）

早期 x86_64 环境曾发生解析失败；当时对 Android 裸 DNS 限制的推断不能视为普遍结论。
后续 ARM64 设备记录了成功的 guest DNS 与 HTTPS（见 STATUS.md §9）。
preload 使用 guest 配置进行解析；安装方仍须提供当前网络可达的 DNS 服务器，
并实际验证解析与 HTTPS，不应把“写入 resolv.conf”当作网络可用的证据。
本脚本不提供 DNS 转发器。

> 注意：`apt-get update` 在 DNS 完全失败时仍返回 **0**（把索引下载失败当 warning）。
> 因此"退出码为 0"不能作为网络可用的证据 —— 见 D-009。

## 7. 与 PRoot 的差异（必须写进验收报告的免责声明）

能力覆盖是**反向**的，这一点必须说清楚：

| 能力 | PRoot | 本 fork |
|------|-------|---------|
| 静态二进制 | ✅ | ❌ 绕过 |
| 直接 syscall | ✅ | ❌ |
| secure-exec（setuid） | ✅ | ❌ |
| 内核级路径虚拟化 | ✅ | ❌（LD_PRELOAD 层） |
| glibc **内部** 文件访问（locale/timezone/gconv） | ✅ | ❌（用环境变量绕开） |
| NSS 模块 / `getent` / 用户名解析 | ✅ | ✅（模块是独立 DSO，走 PLT） |
| 应用经 PLT 的 libc 调用（含 fortify 变体） | ✅ | ✅ |
| 性能 | 每 syscall 约 1.7 ms ptrace 代价 | 每次 open 约 0.03 ms（见 PERF.md） |
| 维护成本 | 低（成熟） | 需跟上 glibc 行为变化 |

> LD_PRELOAD 这一层**不可能**达到 PRoot 的完备性。实测结论：路径操作快约 57 倍、
> 进程创建快约 4.7 倍，但覆盖范围更窄。这也是 D-004 存在的原因。


## 宿主目录直通（`--host-path`）

映射规则之前先判断「直通」，命中则路径原样交给内核，不加 rootfs 前缀：

1. `/proc`、`/sys`、`/dev`（`/dev/shm` 例外，POSIX 共享内存需要有地方可写）；
2. 已经在 rootfs 内的路径（避免二次加前缀）；
3. launcher 自己安装前缀下的路径；
4. `BIONILUX_HOST_PATHS` 列出的宿主机目录——默认是 `/sdcard`、`/storage/emulated/0`，
   以及由 `PREFIX` 推导出的 App 私有目录（`<root>/files/...` → `<root>`）。

第 4 条是给集成方的：App 与 guest 用**同一个绝对路径**访问同一份数据。`--no-android-paths`
关掉默认项，`--host-path DIR` 追加。默认项由 `PREFIX` 推导而非写死，所以 Termux 的 `$PREFIX`
和某个 App 的 `files/` 目录都成立。

## 相对路径与 `..`

不含 `..` 的相对路径直接透传——物理工作目录本来就在 rootfs 内。含 `..` 的必须先换算成
guest 视角：取当前目录的**物理**路径（`/proc/self/fd/N`，且必须用真实的 `readlink`，
不能走会把结果改写成 guest 路径的那个钩子，否则匹配不上 rootfs 前缀、回落成 `/`，
每次 `..` 都会跳到 guest 根目录——`find`/`rm -rf` 的深目录失败就是这么来的），
反解成 guest 路径，拼上 `..` 后按词法归一化（`..` 在 guest 根处钳住），再映射回物理路径。