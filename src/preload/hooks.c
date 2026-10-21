// bionilux LD_PRELOAD hooks (glibc side).
//
// Responsibilities, in order of importance:
//
//   1. Guest path semantics. Every path an application hands to the C library
//      is resolved against the configured rootfs (BIONILUX_ROOTFS), so a
//      Debian user space sees its own /usr, /etc and /var instead of the
//      host's. A path that does not exist inside the rootfs fails there
//      instead of silently resolving against the host.
//   2. Keep children on the loader path, so a rerouted child of a guest
//      process starts inside the same guest.
//   3. Report the guest's own path from /proc/self/exe, getcwd() and
//      readlink().
//   4. Present a root identity, because apt and dpkg refuse to run otherwise.
//   5. Android workarounds (getifaddrs without netlink).
//
// Boundary: these are ordinary libc symbols. They cover anything an
// application calls through the PLT, including programs built with
// _FORTIFY_SOURCE (the __*_chk and __open_2 entry points are hooked too).
// They cannot cover calls the C library makes to itself through hidden
// aliases — NSS, locale and timezone lookups are the notable cases. Those are
// reached with environment variables where glibc offers one.
//
// See docs/ROOTFS.md for the mapping rules this file implements.

#define _GNU_SOURCE
#include <arpa/inet.h>
#include <dirent.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <ifaddrs.h>
#include <limits.h>
#include <link.h>
#include <net/if.h>
#include <netinet/in.h>
#include <spawn.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/random.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/time.h>
#include <sys/types.h>
#include <sys/utsname.h>
#include <time.h>
#include <unistd.h>
#include <utime.h>

extern char **environ;
extern void __chk_fail(void) __attribute__((noreturn));

// ── debug ──────────────────────────────────────────────────────────
static int bionilux_debug(void) {
    static int cached = -1;
    if (cached < 0) {
        const char *v = getenv("BIONILUX_DEBUG");
        cached = (v && *v) ? 1 : 0;
    }
    return cached;
}

#define DBG(...) do { \
    if (bionilux_debug()) fprintf(stderr, "[BIONILUX HOOK] " __VA_ARGS__); \
} while (0)

// Resolve the next definition of `name` into `var`, cached.
#define REAL(var, name) \
    do { if (!(var)) (var) = (__typeof__(var))dlsym(RTLD_NEXT, name); } while (0)

// ── configuration ──────────────────────────────────────────────────
// Keep runtime identity even when a tool calls clearenv() (notably env -i).
// These are configuration paths/flags only, never arbitrary user environment.
static struct { const char *key; char *entry; } bn_context[] = {
    {"BIONILUX_ROOTFS=", NULL}, {"BIONILUX_PREFIX=", NULL},
    {"BIONILUX_RUNTIME_DIR=", NULL}, {"BIONILUX_HOST_PATHS=", NULL},
    {"BIONILUX_ANDROID_PATHS=", NULL}, {"BIONILUX_BOX64=", NULL},
    {"BIONILUX_PRELOAD=", NULL}, {"BIONILUX_LOADER=", NULL},
    {"BIONILUX_GUEST_PATH=", NULL}, {"BIONILUX_GUEST_HOME=", NULL},
    {"BIONILUX_GUEST_TMP=", NULL}, {"BIONILUX_GUEST_CWD=", NULL},
    {"BIONILUX_FAKE_ROOT=", NULL}, {"BIONILUX_LENIENT=", NULL},
    {"BIONILUX_BINARY_PATH=", NULL}, {"BIONILUX_DNS=", NULL},
    {"BIONILUX_DNS_SERVERS=", NULL}
};

static const char *bn_env(const char *name) {
    const char *v = getenv(name);
    if (v) return *v ? v : NULL;
    size_t len = strlen(name);
    for (size_t i = 0; i < sizeof bn_context / sizeof bn_context[0]; i++) {
        if (bn_context[i].entry && strlen(bn_context[i].key) == len + 1 &&
            !strncmp(bn_context[i].key, name, len)) {
            v = bn_context[i].entry + len + 1;
            return *v ? v : NULL;
        }
    }
    return NULL;
}

static const char *bn_rootfs(void) {
    static const char *cached;
    static int init;
    if (!init) { cached = bn_env("BIONILUX_ROOTFS"); init = 1; }
    return cached;
}

static int bn_flag(const char *name) {
    const char *v = bn_env(name);
    return (v && strcmp(v, "0") != 0) ? 1 : 0;
}

static int bn_fake_root(void) {
    static int cached = -1;
    if (cached < 0) cached = bn_flag("BIONILUX_FAKE_ROOT");
    return cached;
}

static int bn_lenient(void) {
    static int cached = -1;
    if (cached < 0) cached = bn_flag("BIONILUX_LENIENT");
    return cached;
}

// The identity the guest is told it has. Declared here because stat() reports
// it as the owner of every file; the setuid()/setgid() family assigns it, and
// the reasoning is documented in the fake root section further down.
static _Atomic uid_t bn_vruid, bn_veuid, bn_vsuid;
static _Atomic gid_t bn_vrgid, bn_vegid, bn_vsgid;

// The host owns every file as the app's own uid, so a file the guest itself
// created reports that uid rather than the guest's identity. Any caller that
// compares a file's owner with its own — git's "dubious ownership" check,
// dpkg, tar — would then refuse to touch its own working tree. Report the
// virtual identity instead, which is also what chown() promised when it
// accepted the change, so the guest's view of ownership stays consistent.
#define BN_VIRT_STAT(st)                       \
    do {                                       \
        if (bn_fake_root()) {                  \
            (st).st_uid = bn_vruid;            \
            (st).st_gid = bn_vrgid;            \
        }                                      \
    } while (0)

// ── path mapping ───────────────────────────────────────────────────
//
// Rules, mirroring src/launcher/rootfs.rs:
//   * only absolute paths are rewritten
//   * /proc, /sys and /dev stay with the host kernel (/dev/shm excepted)
//   * paths already inside the rootfs, or inside the launcher's own install
//     prefix, are left alone so nothing is prefixed twice
//   * a path missing from the rootfs is still rewritten, so the kernel
//     reports ENOENT instead of exposing the host's file of that name

// True when `path` is exactly `prefix` or lives directly below it.
static int bn_under(const char *path, const char *prefix) {
    if (!path || !prefix || !*prefix) return 0;
    size_t n = strlen(prefix);
    if (strncmp(path, prefix, n) != 0) return 0;
    return path[n] == '\0' || path[n] == '/';
}

static int bn_under_any(const char *path, const char *const *prefixes, size_t count) {
    for (size_t i = 0; i < count; i++)
        if (bn_under(path, prefixes[i])) return 1;
    return 0;
}

static const char *const BN_HOST_VIRTUAL[] = { "/proc", "/sys", "/dev" };
static const char *const BN_HOST_VIRTUAL_EXCEPTIONS[] = { "/dev/shm" };

// Host directories the guest reaches through their own absolute path, as set
// by the launcher from --host-path / BIONILUX_HOST_PATHS. These are Android
// paths that must not be prefixed with the rootfs: public storage and the host
// application's private data directory.
static int bn_under_host_paths(const char *path) {
    static char *list;
    static int init;
    if (!init) {
        init = 1;
        const char *v = bn_env("BIONILUX_HOST_PATHS");
        if (v && *v) list = strdup(v);
    }
    if (!list) return 0;

    const char *p = list;
    for (;;) {
        const char *end = strchr(p, ':');
        size_t n = end ? (size_t)(end - p) : strlen(p);
        char item[PATH_MAX];
        if (n > 0 && n < sizeof item) {
            memcpy(item, p, n);
            item[n] = '\0';
            if (bn_under(path, item)) return 1;
        }
        if (!end) return 0;
        p = end + 1;
    }
}

// True when the path must reach the kernel unchanged.
static int bn_passthrough(const char *path) {
    if (!path || path[0] != '/') return 1;
    const char *root = bn_rootfs();
    if (!root) return 1;

    size_t nvirt = sizeof BN_HOST_VIRTUAL / sizeof BN_HOST_VIRTUAL[0];
    size_t nexc = sizeof BN_HOST_VIRTUAL_EXCEPTIONS / sizeof BN_HOST_VIRTUAL_EXCEPTIONS[0];
    if (!bn_under_any(path, BN_HOST_VIRTUAL_EXCEPTIONS, nexc) &&
        bn_under_any(path, BN_HOST_VIRTUAL, nvirt))
        return 1;

    if (bn_under(path, root)) return 1;
    if (bn_under(path, bn_env("BIONILUX_PREFIX"))) return 1;
    if (bn_under(path, bn_env("BIONILUX_RUNTIME_DIR"))) return 1;
    if (bn_under(path, bn_env("BIONILUX_PRELOAD"))) return 1;
    if (bn_under_host_paths(path)) return 1;
    return 0;
}

// Collapse "." and ".." lexically. Symlinks are deliberately not followed
// here: the kernel does that afterwards, using the physical path. ".." is
// clamped at the root, so no amount of traversal escapes the guest.
static void bn_normalize(const char *in, char *out, size_t size) {
    if (size < 2) { if (size) out[0] = '\0'; return; }
    int absolute = (in && in[0] == '/');
    size_t floor = absolute ? 1u : 0u;
    size_t o = 0;
    if (absolute) out[o++] = '/';

    const char *p = in ? in : "";
    while (*p) {
        while (*p == '/') p++;
        if (!*p) break;
        const char *seg = p;
        while (*p && *p != '/') p++;
        size_t len = (size_t)(p - seg);

        if (len == 1 && seg[0] == '.') continue;
        if (len == 2 && seg[0] == '.' && seg[1] == '.') {
            if (o > floor) {
                if (out[o - 1] == '/') o--;
                while (o > floor && out[o - 1] != '/') o--;
            } else if (!absolute) {
                if (o && o + 1 < size) out[o++] = '/';
                if (o + 2 < size) { out[o++] = '.'; out[o++] = '.'; }
            }
            continue;
        }
        if (o > floor && o + 1 < size) out[o++] = '/';
        size_t copy = len;
        if (o + copy + 1 > size) copy = size - o - 1;
        memcpy(out + o, seg, copy);
        o += copy;
    }
    size_t input_len = in ? strlen(in) : 0;
    const char *last = in ? strrchr(in, '/') : NULL;
    last = last ? last + 1 : in;
    int directory = input_len && (in[input_len - 1] == '/' ||
        (last && (!strcmp(last, ".") || !strcmp(last, ".."))));
    if (directory && o > 1 && out[o - 1] != '/' && o + 1 < size) out[o++] = '/';
    if (o == 0) out[o++] = absolute ? '/' : '.';
    out[o < size ? o : size - 1] = '\0';
}

// Rewrite `path` into `buf`, returning either `buf` or `path`.
static const char *bn_map(const char *path, char *buf, size_t size) {
    const char *root = bn_rootfs();
    if (!root || !path || !*path || bn_passthrough(path)) return path;

    char norm[PATH_MAX];
    bn_normalize(path, norm, sizeof norm);

    int written = snprintf(buf, size, "%s%s", root, norm);
    if (written <= 0 || (size_t)written >= size) return path;

    if (bn_lenient() && access(buf, F_OK) != 0) return path;
    DBG("map: %s -> %s\n", path, buf);
    return buf;
}

// Rewrite a physical host path back into the guest's view of it.
static const char *bn_unmap(const char *path, char *buf, size_t size) {
    const char *root = bn_rootfs();
    if (!root || !path || !bn_under(path, root)) return path;
    const char *rest = path + strlen(root);
    if (*rest == '\0') rest = "/";
    int written = snprintf(buf, size, "%s", rest);
    if (written <= 0 || (size_t)written >= size) return path;
    return buf;
}

// True when any component of a relative path is "..".
static int bn_has_dotdot(const char *path) {
    const char *p = path;
    while (*p) {
        while (*p == '/') p++;
        const char *seg = p;
        while (*p && *p != '/') p++;
        if (p - seg == 2 && seg[0] == '.' && seg[1] == '.') return 1;
    }
    return 0;
}

// The process's physical working directory, bypassing our own unmapping hook.
static int bn_physical_cwd(char *buf, size_t size) {
    typedef char *(*fn_t)(char *, size_t);
    static _Thread_local fn_t real;
    REAL(real, "getcwd");
    return real && real(buf, size) != NULL;
}

static ssize_t resolve_fd_path(int fd, char *buf, size_t size);

// Physical directory a path argument is resolved against.
static int bn_dir_base(int dirfd, char *buf, size_t size) {
    if (dirfd == AT_FDCWD) return bn_physical_cwd(buf, size);
    return resolve_fd_path(dirfd, buf, size) > 0;
}

// Resolve a path argument the way the guest means it.
//
// The subtle case is a relative path containing "..". Handing it to the kernel
// resolves it against the *physical* working directory, so from guest / a path
// like ../foo would climb out of the rootfs and reach the host. Resolving such
// paths against the guest working directory first — with ".." clamped at the
// guest root — keeps the traversal inside the guest.
//
// Relative paths without ".." cannot escape the physical working directory,
// which is already inside the rootfs, so they are passed through untouched.
static const char *bn_resolve(int dirfd, const char *path, char *buf, size_t size) {
    if (!path || !*path) return path;
    if (path[0] == '/') return bn_map(path, buf, size);
    if (!bn_rootfs()) return path;

    int dotdot = bn_has_dotdot(path);
    // A component-wise walk (GNU mkdir -p, for example) starts at guest /
    // and eventually reaches an authorized host mount. Even a plain relative
    // component must switch to that host directory at the mount boundary.
    // Passing it through would instead create a shadow tree below rootfs/data.
    if (!dotdot) {
        char physical[PATH_MAX], logical_buf[PATH_MAX], joined[PATH_MAX];
        if (!bn_dir_base(dirfd, physical, sizeof physical)) return path;
        const char *logical = bn_unmap(physical, logical_buf, sizeof logical_buf);
        if (logical == physical) return path;
        int n = snprintf(joined, sizeof joined, "%s/%s", logical, path);
        if (n <= 0 || (size_t)n >= sizeof joined) return path;
        char norm[PATH_MAX];
        bn_normalize(joined, norm, sizeof norm);
        if (!bn_under_host_paths(norm)) return path;
        n = snprintf(buf, size, "%s", norm);
        if (n <= 0 || (size_t)n >= size) return path;
        return buf;
    }

    char base[PATH_MAX];
    if (!bn_dir_base(dirfd, base, sizeof base)) return path;

    char logical_base[PATH_MAX];
    const char *logical = bn_unmap(base, logical_base, sizeof logical_base);
    if (logical == base) {
        if (bn_passthrough(base)) return path;
        logical = "/";
    }

    char joined[PATH_MAX];
    int n = snprintf(joined, sizeof joined, "%s/%s", logical, path);
    if (n <= 0 || (size_t)n >= sizeof joined) return path;

    char norm[PATH_MAX];
    bn_normalize(joined, norm, sizeof norm);
    return bn_map(norm, buf, size);
}

// ── rerouting ──────────────────────────────────────────────────────
static int is_launcher(const char *path, const char *launcher) {
    return launcher && path && strcmp(path, launcher) == 0;
}

// A caller may supply a minimal child environment. Keep only the runtime's
// own configuration when absent from envp; never inherit arbitrary host values.
static char **strip_ld_preload(char *const envp[]) {
    size_t envc = 0;
    while (envp && envp[envc]) envc++;
    const char *preload = NULL;
    for (size_t i = 0; i < envc; i++)
        if (!strncmp(envp[i], "LD_PRELOAD=", 11)) preload = envp[i] + 11;
    size_t slots = envc + sizeof bn_context / sizeof bn_context[0] + 2;
    size_t extra = preload ? sizeof "BIONILUX_INTERNAL_PRELOAD=" + strlen(preload) : 0;
    char **ev = malloc(slots * sizeof *ev + extra);
    if (!ev) return NULL;
    size_t j = 0;
    for (size_t i = 0; i < envc; i++)
        if (strncmp(envp[i], "LD_PRELOAD=", 11) != 0 &&
            strncmp(envp[i], "BIONILUX_INTERNAL_PRELOAD=", sizeof "BIONILUX_INTERNAL_PRELOAD=" - 1) != 0) ev[j++] = envp[i];
    if (preload) {
        char *saved = (char *)(ev + slots);
        snprintf(saved, extra, "BIONILUX_INTERNAL_PRELOAD=%s", preload);
        ev[j++] = saved;
    }
    for (size_t key = 0; key < sizeof bn_context / sizeof bn_context[0]; key++) {
        size_t len = strlen(bn_context[key].key);
        int provided = 0;
        for (size_t i = 0; i < envc; i++)
            if (!strncmp(envp[i], bn_context[key].key, len)) { provided = 1; break; }
        if (provided) continue;
        char *entry = bn_context[key].entry;
        for (size_t i = 0; environ && environ[i]; i++)
            if (!strncmp(environ[i], bn_context[key].key, len)) { entry = environ[i]; break; }
        if (entry) ev[j++] = entry;
    }
    ev[j] = NULL;
    return ev;
}

static int bn_check_interpreter(const char *script, unsigned depth);

// As with glibc execvpe(), search the caller's PATH, not envp's PATH.
static int bn_which(const char *name, const char *path, char *out, size_t size) {
    if (!name || !*name) { errno = ENOENT; return 0; }
    if (!path) path = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
    int denied = 0;
    for (const char *p = path; ; ) {
        const char *end = strchr(p, ':');
        size_t len = end ? (size_t)(end - p) : strlen(p);
        int n = len ? snprintf(out, size, "%.*s/%s", (int)len, p, name)
                    : snprintf(out, size, "./%s", name);
        if (n > 0 && (size_t)n < size) {
            if (bn_check_interpreter(out, 0) == 0 || errno == ENOEXEC) return 1;
            switch (errno) {
                case EACCES: denied = 1; break;
                case ENOENT: case ENOTDIR: case ESTALE: case ENODEV: case ETIMEDOUT: break;
                default: return 0;
            }
        }
        if (!end) break;
        p = end + 1;
    }
    errno = denied ? EACCES : ENOENT;
    return 0;
}

// Fail before replacing the caller if the kernel-level shebang interpreter
// cannot execute. env's optional program is deliberately left to env itself.
static int bn_check_interpreter(const char *script, unsigned depth) {
    typedef int (*open_fn)(const char *, int, ...);
    static _Thread_local open_fn real_open;
    REAL(real_open, "open");
    char mapped[PATH_MAX], line[PATH_MAX];
    const char *physical = bn_resolve(AT_FDCWD, script, mapped, sizeof mapped);
    if (access(physical, X_OK) != 0) return -1;
    struct stat st;
    if (stat(physical, &st) != 0) return -1;
    if (!S_ISREG(st.st_mode)) { errno = EACCES; return -1; }
    int fd = real_open ? real_open(physical, O_RDONLY | O_CLOEXEC | O_NONBLOCK) : -1;
    if (fd < 0) return -1;
    ssize_t got;
    do { got = read(fd, line, sizeof line - 1); } while (got < 0 && errno == EINTR);
    int saved = errno;
    close(fd);
    if (got < 0) { errno = saved; return -1; }
    if (got >= 4 && !memcmp(line, "\177ELF", 4)) return 0;
    if (got < 2 || line[0] != '#' || line[1] != '!') { errno = ENOEXEC; return -1; }
    if (depth >= 4) { errno = ELOOP; return -1; }
    line[got] = '\0';
    char *start = line + 2;
    while (*start == ' ' || *start == '\t') start++;
    char *end = start;
    while (*end && *end != ' ' && *end != '\t' && *end != '\r' && *end != '\n') end++;
    *end = '\0';
    if (!*start) { errno = ENOEXEC; return -1; }
    char legacy[PATH_MAX];
    const char *prefix = bn_env("BIONILUX_PREFIX");
    if (!bn_rootfs() && prefix) {
        const char *rest = NULL;
        if (!strncmp(start, "/bin/", 5)) rest = start + 5;
        else if (!strncmp(start, "/usr/bin/", 9)) rest = start + 9;
        if (rest) {
            int n = snprintf(legacy, sizeof legacy, "%s/bin/%s", prefix, rest);
            if (n < 0 || (size_t)n >= sizeof legacy) { errno = ENAMETOOLONG; return -1; }
            start = legacy;
        }
    }
    return bn_check_interpreter(start, depth + 1);
}

// Build [launcher, target, argv[1..]] with a stripped envp.
// Returns 1 when the call was rerouted, 0 when it should be handed to the
// kernel untouched, and -1 when `target` cannot be resolved at all — a bare
// name that is not in the guest's PATH must not fall through to libc, which
// would then search the host's.
static int reroute(int search_path, const char *target, char *const argv[], char *const envp[],
                   const char **launcher, char ***nargv, char ***nenvp) {
    *launcher = bn_env("BIONILUX_BINARY_PATH");
    if (!*launcher || !target || is_launcher(target, *launcher)) return 0;

    char resolved[PATH_MAX];
    if (!strchr(target, '/')) {
        if (search_path) {
            if (!bn_which(target, getenv("PATH"), resolved, sizeof resolved)) return -1;
        } else {
            int n = snprintf(resolved, sizeof resolved, "./%s", target);
            if (n < 0 || (size_t)n >= sizeof resolved) { errno = ENAMETOOLONG; return -1; }
        }
        target = resolved;
    }

    // Report pre-exec errors to the caller, not as a launcher child exit.
    int shell_fallback = 0;
    // The probe must use the mapped path: an absolute guest path does not
    // exist on the host.
    if (strchr(target, '/')) {
        char buf[PATH_MAX];
        const char *probe = bn_resolve(AT_FDCWD, target, buf, sizeof buf);
        if (access(probe, X_OK) != 0) return -1;
        struct stat st;
        if (stat(probe, &st) != 0) return -1;
        if (!S_ISREG(st.st_mode)) { errno = EACCES; return -1; }
        typedef int (*open_fn)(const char *, int, ...);
        static _Thread_local open_fn real_open;
        REAL(real_open, "open");
        int fd = real_open ? real_open(probe, O_RDONLY | O_CLOEXEC | O_NONBLOCK) : -1;
        if (fd >= 0) {
            unsigned char magic[4];
            ssize_t got;
            do { got = read(fd, magic, sizeof magic); } while (got < 0 && errno == EINTR);
            close(fd);
            if (got >= 2 && magic[0] == '#' && magic[1] == '!') {
                if (bn_check_interpreter(probe, 0) != 0) {
                    if (errno != ENOEXEC || search_path != 1) return -1;
                    shell_fallback = 1;
                }
            }
            if (got >= 0 && !(got >= 2 && magic[0] == '#' && magic[1] == '!') &&
                !(got == 4 && memcmp(magic, "\177ELF", 4) == 0)) {
                if (search_path != 1) { errno = ENOEXEC; return -1; }
                shell_fallback = 1;
            }
        }
    }

    size_t argc = 0;
    while (argv && argv[argc]) argc++;
    size_t n = argc ? argc : 1;

    const char *original_argv0 = shell_fallback ? "/bin/sh" : (argc ? argv[0] : "");
    size_t target_len = strlen(target) + 1;
    size_t argv0_len = strlen(original_argv0) + 1;
    char **av = malloc((n + 6) * sizeof *av + target_len + argv0_len);
    char **ev = strip_ld_preload(envp);
    if (!av || !ev) { free(av); free(ev); errno = ENOMEM; return -1; }

    av[0] = (char *)*launcher;
    av[1] = "--argv0";
    av[2] = (char *)(av + n + 6);
    memcpy(av[2], original_argv0, argv0_len);
    av[3] = "--";
    // Both strings may originate in a caller's stack; own them until exec/spawn.
    av[4] = av[2] + argv0_len;
    memcpy(av[4], target, target_len);
    size_t offset = 4;
    if (shell_fallback) { av[5] = av[4]; av[4] = "/bin/sh"; offset++; }
    for (size_t i = 1; i < argc; i++) av[i + offset] = argv[i];
    av[n + offset] = NULL;

    *nargv = av;
    *nenvp = ev;
    DBG("Routing through bionilux: %s\n", target);
    return 1;
}

static int real_execve(const char *p, char *const a[], char *const e[]) {
    typedef int (*fn_t)(const char *, char *const[], char *const[]);
    static _Thread_local fn_t fn;
    REAL(fn, "execve");
    return fn(p, a, e);
}

static int run_rerouted(const char *launcher, char **av, char **ev) {
    int r = real_execve(launcher, av, ev);
    int e = errno;
    free(av); free(ev);
    errno = e;
    return r;
}

static int exec_launcher(const char *path, char *const argv[], char *const envp[]) {
    char **clean = strip_ld_preload(envp);
    if (!clean) { errno = ENOMEM; return -1; }
    int r = real_execve(path, argv, clean);
    int e = errno;
    free(clean);
    errno = e;
    return r;
}

// ── exec* family ───────────────────────────────────────────────────
int execve(const char *path, char *const argv[], char *const envp[]) {
    DBG("HOOK execve(%s)\n", path);
    if (is_launcher(path, bn_env("BIONILUX_BINARY_PATH")))
        return exec_launcher(path, argv, envp);
    const char *l; char **av, **ev;
    int r = reroute(0, path, argv, envp, &l, &av, &ev);
    if (r < 0) return -1;
    if (r) return run_rerouted(l, av, ev);
    return real_execve(path, argv, envp);
}

int execv(const char *path, char *const argv[]) {
    return execve(path, argv, environ);
}

int execvp(const char *file, char *const argv[]) {
    typedef int (*fn_t)(const char *, char *const[]);
    static _Thread_local fn_t real;
    REAL(real, "execvp");
    DBG("HOOK execvp(%s)\n", file);
    if (is_launcher(file, bn_env("BIONILUX_BINARY_PATH")))
        return exec_launcher(file, argv, environ);
    const char *l; char **av, **ev;
    int r = reroute(1, file, argv, environ, &l, &av, &ev);
    if (r < 0) return -1;
    if (r) return run_rerouted(l, av, ev);
    return real(file, argv);
}

// execvpe() is a separate public symbol, not an alias of execvp(): it searches
// the caller's PATH (envp supplies only the child's environment). GNU make calls it for every
// recipe, handing each child its own environment, so leaving it to libc made
// make's direct-exec path — the one used whenever a command has no shell
// metacharacter — resolve on the host and fail with ENOENT. That is what broke
// a recursive kernel build as `make: /usr/bin/make: No such file or directory`.
int execvpe(const char *file, char *const argv[], char *const envp[]) {
    if (is_launcher(file, bn_env("BIONILUX_BINARY_PATH")))
        return exec_launcher(file, argv, envp);
    const char *l; char **av, **ev;
    int r = reroute(1, file, argv, envp, &l, &av, &ev);
    if (r < 0) return -1;
    if (r) return run_rerouted(l, av, ev);

    typedef int (*fn_t)(const char *, char *const[], char *const[]);
    static _Thread_local fn_t real;
    REAL(real, "execvpe");
    if (real) return real(file, argv, envp);
    errno = ENOSYS;
    return -1;
}

// va_list -> argv. Pointer so the caller's position advances on aarch64
// (va_list is a struct, not an array). Caller frees.
static char **va_to_argv(const char *arg0, va_list *app) {
    size_t n = 1;
    va_list copy;
    va_copy(copy, *app);
    while (va_arg(copy, const char *)) n++;
    va_end(copy);

    char **argv = malloc((n + 1) * sizeof *argv);
    if (!argv) return NULL;

    argv[0] = (char *)arg0;
    for (size_t i = 1; i < n; i++) argv[i] = va_arg(*app, char *);
    argv[n] = NULL;
    return argv;
}

int execl(const char *path, const char *arg0, ...) {
    va_list ap; va_start(ap, arg0);
    char **argv = va_to_argv(arg0, &ap);
    va_end(ap);
    if (!argv) { errno = ENOMEM; return -1; }
    int r = execve(path, argv, environ);
    int e = errno; free(argv); errno = e;
    return r;
}

int execlp(const char *file, const char *arg0, ...) {
    va_list ap; va_start(ap, arg0);
    char **argv = va_to_argv(arg0, &ap);
    va_end(ap);
    if (!argv) { errno = ENOMEM; return -1; }
    int r = execvp(file, argv);
    int e = errno; free(argv); errno = e;
    return r;
}

int execle(const char *path, const char *arg0, ...) {
    va_list ap; va_start(ap, arg0);
    char **argv = va_to_argv(arg0, &ap);
    (void)va_arg(ap, char *);  // consume trailing NULL
    char *const *envp = va_arg(ap, char *const *);
    va_end(ap);
    if (!argv) { errno = ENOMEM; return -1; }
    int r = execve(path, argv, envp);
    int e = errno; free(argv); errno = e;
    return r;
}

// /proc/self/fd/N -> real path. -1 for memfd/(deleted) or on error.
static ssize_t resolve_fd_path(int fd, char *buf, size_t size) {
    // The physical path is required here, so bypass our own readlinkat hook:
    // it rewrites the target into the guest's view, and a caller that resolves
    // a relative argument against this result would then hand a logical path
    // to code that expects a host path.
    typedef ssize_t (*fn_t)(int, const char *, char *, size_t);
    static _Thread_local fn_t real; REAL(real, "readlinkat");
    if (!real) return -1;
    char link[64];
    int n = snprintf(link, sizeof link, "/proc/self/fd/%d", fd);
    if (n < 0 || (size_t)n >= sizeof link) return -1;
    ssize_t r = real(AT_FDCWD, link, buf, size);
    if (r <= 0 || (size_t)r >= size) return -1;
    buf[r] = '\0';
    if (strstr(buf, " (deleted)")) return -1;
    if (strncmp(buf, "memfd:", 6) == 0) return -1;
    return r;
}

int fexecve(int fd, char *const argv[], char *const envp[]) {
    typedef int (*fn_t)(int, char *const[], char *const[]);
    static _Thread_local fn_t real;
    REAL(real, "fexecve");
    if (bn_env("BIONILUX_BINARY_PATH")) {
        char path[PATH_MAX];
        if (resolve_fd_path(fd, path, sizeof path) > 0)
            return execve(path, argv, envp);
    }
    if (real) return real(fd, argv, envp);
    errno = ENOSYS; return -1;
}

int execveat(int dirfd, const char *path, char *const argv[],
             char *const envp[], int flags) {
    typedef int (*fn_t)(int, const char *, char *const[], char *const[], int);
    static _Thread_local fn_t real;
    REAL(real, "execveat");
    if (flags & ~(AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW)) { errno = EINVAL; return -1; }
    if (bn_env("BIONILUX_BINARY_PATH")) {
        if (!*path) {
            if (flags & AT_EMPTY_PATH) return fexecve(dirfd, argv, envp);
        } else {
            char mapped[PATH_MAX];
            const char *target = bn_resolve(dirfd, path, mapped, sizeof mapped);
            if (flags & AT_SYMLINK_NOFOLLOW) {
                struct stat st;
                if (fstatat(dirfd, target, &st, AT_SYMLINK_NOFOLLOW) != 0) return -1;
                if (S_ISLNK(st.st_mode)) { errno = ELOOP; return -1; }
            }
            if (*target == '/' || dirfd == AT_FDCWD) return execve(target, argv, envp);
            char base[PATH_MAX], joined[PATH_MAX];
            if (resolve_fd_path(dirfd, base, sizeof base) > 0) {
                int n = snprintf(joined, sizeof joined, "%s/%s", base, target);
                if (n < 0 || (size_t)n >= sizeof joined) { errno = ENAMETOOLONG; return -1; }
                return execve(joined, argv, envp);
            }
        }
    }
    if (real) return real(dirfd, path, argv, envp, flags);
    errno = ENOSYS; return -1;
}

// ── posix_spawn* ───────────────────────────────────────────────────
typedef int (*spawn_fn)(pid_t *, const char *, const posix_spawn_file_actions_t *,
                        const posix_spawnattr_t *, char *const[], char *const[]);

static spawn_fn spawn_plain(void) {
    static _Thread_local spawn_fn fn;
    REAL(fn, "posix_spawn");
    return fn;
}

static int spawn_impl(int search_path, pid_t *pid, const char *path,
                      const posix_spawn_file_actions_t *fa, const posix_spawnattr_t *attr,
                      char *const argv[], char *const envp[]) {
    spawn_fn plain = spawn_plain();
    if (!plain) return ENOSYS;
    DBG("HOOK spawn(p=%d, %s)\n", search_path, path ? path : "(null)");

    if (is_launcher(path, bn_env("BIONILUX_BINARY_PATH"))) {
        char **clean = strip_ld_preload(envp);
        if (!clean) return ENOMEM;
        int r = plain(pid, path, fa, attr, argv, clean);
        int e = errno; free(clean); errno = e;
        return r;
    }

    const char *l; char **av, **ev;
    int re = reroute(search_path ? 2 : 0, path, argv, envp, &l, &av, &ev);
    if (re < 0) return errno;
    if (re) {
        int r = plain(pid, l, fa, attr, av, ev);
        int e = errno; free(av); free(ev); errno = e;
        return r;
    }

    if (search_path) {
        typedef int (*fn_t)(pid_t *, const char *, const posix_spawn_file_actions_t *,
                            const posix_spawnattr_t *, char *const[], char *const[]);
        static _Thread_local fn_t real;
        REAL(real, "posix_spawnp");
        if (real) return real(pid, path, fa, attr, argv, envp);
        return ENOSYS;
    }
    return plain(pid, path, fa, attr, argv, envp);
}

int posix_spawn(pid_t *pid, const char *path, const posix_spawn_file_actions_t *fa,
                const posix_spawnattr_t *attr, char *const argv[], char *const envp[]) {
    return spawn_impl(0, pid, path, fa, attr, argv, envp);
}

int posix_spawnp(pid_t *pid, const char *file, const posix_spawn_file_actions_t *fa,
                 const posix_spawnattr_t *attr, char *const argv[], char *const envp[]) {
    return spawn_impl(1, pid, file, fa, attr, argv, envp);
}

// ── open family ────────────────────────────────────────────────────
// O_TMPFILE does not include O_CREAT but still takes a mode argument.
static int open_uses_mode(int flags) {
#ifdef O_TMPFILE
    if ((flags & O_TMPFILE) == O_TMPFILE) return 1;
#endif
    return (flags & O_CREAT) != 0;
}

typedef int (*open_fn)(const char *, int, ...);
typedef int (*openat_fn)(int, const char *, int, ...);

int open(const char *path, int flags, ...) {
    static _Thread_local open_fn real; REAL(real, "open");
    char buf[PATH_MAX];
    const char *t = bn_resolve(AT_FDCWD, path, buf, sizeof buf);
    if (open_uses_mode(flags)) {
        va_list ap; va_start(ap, flags);
        mode_t mode = va_arg(ap, mode_t); va_end(ap);
        return real(t, flags, mode);
    }
    return real(t, flags);
}

int open64(const char *path, int flags, ...) {
    static _Thread_local open_fn real; REAL(real, "open64");
    char buf[PATH_MAX];
    const char *t = bn_resolve(AT_FDCWD, path, buf, sizeof buf);
    if (open_uses_mode(flags)) {
        va_list ap; va_start(ap, flags);
        mode_t mode = va_arg(ap, mode_t); va_end(ap);
        return real(t, flags, mode);
    }
    return real(t, flags);
}

// _FORTIFY_SOURCE rewrites open() with a literal path into __open_2.
int __open_2(const char *path, int flags) {
    static _Thread_local open_fn real; REAL(real, "__open_2");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), flags);
}

int __open64_2(const char *path, int flags) {
    static _Thread_local open_fn real; REAL(real, "__open64_2");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), flags);
}

int creat(const char *path, mode_t mode) {
    return open(path, O_CREAT | O_WRONLY | O_TRUNC, mode);
}

// dlopen() takes a path, and the dynamic loader then reads it with its own
// syscalls, which no preload can see. An absolute path — how a language
// runtime loads an extension module from its @INC / sys.path, and how PAM, NSS
// plugins and SASL mechanisms are opened — would therefore be searched on the
// *host*. Mapping it here is what makes those loads find the guest's copy.
void *dlopen(const char *filename, int flags) {
    typedef void *(*fn_t)(const char *, int);
    static _Thread_local fn_t real; REAL(real, "dlopen");
    if (!real) { errno = ENOSYS; return NULL; }
    if (!filename || !*filename || !bn_rootfs()) return real(filename, flags);
    DBG("dlopen: %s flags=0x%x\n", filename, flags);
    // DEEPBIND puts libc ahead of the preload in a plugin's symbol scope,
    // disabling guest paths and DNS for that plugin (Julia's bundled libcurl
    // is one real example). A rootfs depends on interposition, so keep the
    // ordinary loader scope while it is enabled. No-rootfs use is unchanged.
    flags &= ~RTLD_DEEPBIND;
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, filename, buf, sizeof buf), flags);
}

int creat64(const char *path, mode_t mode) {
    return open64(path, O_CREAT | O_WRONLY | O_TRUNC, mode);
}

int openat(int dirfd, const char *path, int flags, ...) {
    static _Thread_local openat_fn real; REAL(real, "openat");
    char buf[PATH_MAX];
    const char *t = bn_resolve(dirfd, path, buf, sizeof buf);
    if (open_uses_mode(flags)) {
        va_list ap; va_start(ap, flags);
        mode_t mode = va_arg(ap, mode_t); va_end(ap);
        return real(dirfd, t, flags, mode);
    }
    return real(dirfd, t, flags);
}

int openat64(int dirfd, const char *path, int flags, ...) {
    static _Thread_local openat_fn real; REAL(real, "openat64");
    char buf[PATH_MAX];
    const char *t = bn_resolve(dirfd, path, buf, sizeof buf);
    if (open_uses_mode(flags)) {
        va_list ap; va_start(ap, flags);
        mode_t mode = va_arg(ap, mode_t); va_end(ap);
        return real(dirfd, t, flags, mode);
    }
    return real(dirfd, t, flags);
}

int __openat_2(int dirfd, const char *path, int flags) {
    static _Thread_local openat_fn real; REAL(real, "__openat_2");
    char buf[PATH_MAX];
    const char *t = bn_resolve(dirfd, path, buf, sizeof buf);
    return real(dirfd, t, flags);
}

int __openat64_2(int dirfd, const char *path, int flags) {
    static _Thread_local openat_fn real; REAL(real, "__openat64_2");
    char buf[PATH_MAX];
    const char *t = bn_resolve(dirfd, path, buf, sizeof buf);
    return real(dirfd, t, flags);
}

// stdio entry points. Applications call these directly; glibc's own internal
// callers cannot be intercepted, so both layers matter.
FILE *fopen(const char *path, const char *mode) {
    typedef FILE *(*fn_t)(const char *, const char *);
    static _Thread_local fn_t real; REAL(real, "fopen");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), mode);
}

FILE *fopen64(const char *path, const char *mode) {
    typedef FILE *(*fn_t)(const char *, const char *);
    static _Thread_local fn_t real; REAL(real, "fopen64");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), mode);
}

FILE *freopen(const char *path, const char *mode, FILE *stream) {
    typedef FILE *(*fn_t)(const char *, const char *, FILE *);
    static _Thread_local fn_t real; REAL(real, "freopen");
    if (!path) return real(NULL, mode, stream);
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), mode, stream);
}

DIR *opendir(const char *path) {
    typedef DIR *(*fn_t)(const char *);
    static _Thread_local fn_t real; REAL(real, "opendir");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf));
}

// ── stat / access ──────────────────────────────────────────────────
// Managed runtimes may explicitly resolve e.g. chmod from a libc handle.
// That bypasses ELF interposition even though the program is dynamically
// linked. Redirect only our path/identity wrappers, and only libc handles;
// RTLD_NEXT must remain untouched because every REAL() lookup relies on it.
typedef void *(*bn_dlsym_fn)(void *, const char *);
__attribute__((visibility("hidden"))) bn_dlsym_fn bn_real_dlsym;

__attribute__((used, visibility("hidden")))
bn_dlsym_fn bn_dlsym_init(void) {
    bn_dlsym_fn real = __atomic_load_n(&bn_real_dlsym, __ATOMIC_ACQUIRE);
    if (!real) {
#if defined(__x86_64__)
        real = (bn_dlsym_fn)dlvsym(RTLD_NEXT, "dlsym", "GLIBC_2.2.5");
#elif defined(__aarch64__)
        real = (bn_dlsym_fn)dlvsym(RTLD_NEXT, "dlsym", "GLIBC_2.17");
#endif
        __atomic_store_n(&bn_real_dlsym, real, __ATOMIC_RELEASE);
    }
    return real;
}

// Special handles depend on the caller's return address. Tail forwarding
// them from assembly preserves RTLD_NEXT's actual caller, rather than making
// it incorrectly search after this preload for every DSO in the process.
#if defined(__x86_64__)
__asm__(
    ".text\n.p2align 4\n.globl dlsym\n.type dlsym,@function\ndlsym:\n"
    "test %rdi,%rdi\nje 1f\ncmp $-1,%rdi\nje 1f\njmp bn_dlsym_dispatch\n"
    "1: mov bn_real_dlsym(%rip),%rax\ntest %rax,%rax\nje 2f\njmp *%rax\n"
    "2: push %rdi\npush %rsi\nsub $8,%rsp\ncall bn_dlsym_init\nadd $8,%rsp\npop %rsi\npop %rdi\njmp *%rax\n"
    ".size dlsym,.-dlsym\n"
);
#elif defined(__aarch64__)
__asm__(
    ".text\n.p2align 4\n.globl dlsym\n.type dlsym,%function\ndlsym:\n"
    "cbz x0,1f\ncmn x0,#1\nb.eq 1f\nb bn_dlsym_dispatch\n"
    "1: adrp x9,bn_real_dlsym\nldr x9,[x9,:lo12:bn_real_dlsym]\ncbz x9,2f\nbr x9\n"
    "2: stp x0,x1,[sp,#-32]!\nstp x29,x30,[sp,#16]\nbl bn_dlsym_init\nmov x9,x0\nldp x29,x30,[sp,#16]\nldp x0,x1,[sp],#32\nbr x9\n"
    ".size dlsym,.-dlsym\n"
);
#endif

__attribute__((used, visibility("hidden")))
void *bn_dlsym_dispatch(void *handle, const char *name) {
    bn_dlsym_fn real = bn_dlsym_init();
    static _Thread_local int active;
    if (!real) return NULL;
    void *result = real(handle, name);
    if (!result || active || handle == RTLD_NEXT || handle == RTLD_DEFAULT || !bn_rootfs()) return result;
    int saved = errno;
    active = 1;
    Dl_info implementation;
    if (dladdr(result, &implementation) && implementation.dli_fname) {
        // A lookup on another DSO can still resolve a dependency's libc
        // implementation, as Julia's symbol resolver does for mkstemp.
        // Judge the resolved definition, not merely the requested handle.
        const char *leaf = strrchr(implementation.dli_fname, '/');
        leaf = leaf ? leaf + 1 : implementation.dli_fname;
        if (!strcmp(leaf, "libc.so.6")) {
            // Only substitute symbols actually defined by this preload. This
            // also covers temporary-file and spawn APIs without maintaining a
            // second, inevitably incomplete list of the interposed functions.
            void *hook = real(RTLD_DEFAULT, name);
            Dl_info own, selected;
            if (hook && dladdr((void *)&bn_resolve, &own) && dladdr(hook, &selected) && own.dli_fbase == selected.dli_fbase) {
                DBG("libc lookup redirected: %s\n", name);
                result = hook;
            }
        }
    }
    active = 0;
    errno = saved;
    return result;
}

// Older glibc binaries (including .NET's System.Native) call the versioned
// __xstat ABI rather than stat. Its hidden libc implementation does not pass
// through our public stat hook. Forward the version unchanged so unsupported
// ABI versions still fail instead of interpreting the wrong struct layout.
#define BN_XSTAT(name, type) \
int name(int version, const char *path, type *st) { \
    typedef int (*fn_t)(int, const char *, type *); \
    static _Thread_local fn_t real; REAL(real, #name); \
    if (!real) { errno = ENOSYS; return -1; } \
    char buf[PATH_MAX]; \
    int rc = real(version, bn_resolve(AT_FDCWD, path, buf, sizeof buf), st); \
    if (rc == 0) BN_VIRT_STAT(*st); \
    return rc; \
}
BN_XSTAT(__xstat, struct stat)
BN_XSTAT(__lxstat, struct stat)
BN_XSTAT(__xstat64, struct stat64)
BN_XSTAT(__lxstat64, struct stat64)
#undef BN_XSTAT

#define BN_FXSTAT(name, type) \
int name(int version, int fd, type *st) { \
    typedef int (*fn_t)(int, int, type *); \
    static _Thread_local fn_t real; REAL(real, #name); \
    if (!real) { errno = ENOSYS; return -1; } \
    int rc = real(version, fd, st); \
    if (rc == 0) BN_VIRT_STAT(*st); \
    return rc; \
}
BN_FXSTAT(__fxstat, struct stat)
BN_FXSTAT(__fxstat64, struct stat64)
#undef BN_FXSTAT

#define BN_FXSTATAT(name, type) \
int name(int version, int fd, const char *path, type *st, int flags) { \
    typedef int (*fn_t)(int, int, const char *, type *, int); \
    static _Thread_local fn_t real; REAL(real, #name); \
    if (!real) { errno = ENOSYS; return -1; } \
    char buf[PATH_MAX]; \
    int rc = real(version, fd, bn_resolve(fd, path, buf, sizeof buf), st, flags); \
    if (rc == 0) BN_VIRT_STAT(*st); \
    return rc; \
}
BN_FXSTATAT(__fxstatat, struct stat)
BN_FXSTATAT(__fxstatat64, struct stat64)
#undef BN_FXSTATAT

int stat(const char *path, struct stat *st) {
    typedef int (*fn_t)(const char *, struct stat *);
    static _Thread_local fn_t real; REAL(real, "stat");
    char buf[PATH_MAX];
    int rc = real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), st);
    if (rc == 0) BN_VIRT_STAT(*st);
    return rc;
}

int lstat(const char *path, struct stat *st) {
    typedef int (*fn_t)(const char *, struct stat *);
    static _Thread_local fn_t real; REAL(real, "lstat");
    char buf[PATH_MAX];
    int rc = real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), st);
    if (rc == 0) BN_VIRT_STAT(*st);
    return rc;
}

int stat64(const char *path, struct stat64 *st) {
    typedef int (*fn_t)(const char *, struct stat64 *);
    static _Thread_local fn_t real; REAL(real, "stat64");
    char buf[PATH_MAX];
    int rc = real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), st);
    if (rc == 0) BN_VIRT_STAT(*st);
    return rc;
}

int lstat64(const char *path, struct stat64 *st) {
    typedef int (*fn_t)(const char *, struct stat64 *);
    static _Thread_local fn_t real; REAL(real, "lstat64");
    char buf[PATH_MAX];
    int rc = real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), st);
    if (rc == 0) BN_VIRT_STAT(*st);
    return rc;
}

int fstatat(int dirfd, const char *path, struct stat *st, int flags) {
    typedef int (*fn_t)(int, const char *, struct stat *, int);
    static _Thread_local fn_t real; REAL(real, "fstatat");
    char buf[PATH_MAX];
    const char *t = bn_resolve(dirfd, path, buf, sizeof buf);
    int rc = real(dirfd, t, st, flags);
    if (rc == 0) BN_VIRT_STAT(*st);
    return rc;
}

int fstatat64(int dirfd, const char *path, struct stat64 *st, int flags) {
    typedef int (*fn_t)(int, const char *, struct stat64 *, int);
    static _Thread_local fn_t real; REAL(real, "fstatat64");
    char buf[PATH_MAX];
    const char *t = bn_resolve(dirfd, path, buf, sizeof buf);
    int rc = real(dirfd, t, st, flags);
    if (rc == 0) BN_VIRT_STAT(*st);
    return rc;
}

// A descriptor the guest opened must report the same owner as the path it
// opened, or a program that stats a file both ways sees two different owners.
int fstat(int fd, struct stat *st) {
    typedef int (*fn_t)(int, struct stat *);
    static _Thread_local fn_t real; REAL(real, "fstat");
    int rc = real(fd, st);
    if (rc == 0) BN_VIRT_STAT(*st);
    return rc;
}

int fstat64(int fd, struct stat64 *st) {
    typedef int (*fn_t)(int, struct stat64 *);
    static _Thread_local fn_t real; REAL(real, "fstat64");
    int rc = real(fd, st);
    if (rc == 0) BN_VIRT_STAT(*st);
    return rc;
}

int access(const char *path, int mode) {
    typedef int (*fn_t)(const char *, int);
    static _Thread_local fn_t real; REAL(real, "access");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), mode);
}

// glibc implements euidaccess()/eaccess() in user space: it cannot use the
// access(2) syscall, because that tests the *real* uid, so it stat()s the path
// itself and compares the mode bits against the effective uid. That stat is an
// internal call no preload can see, so an absolute guest path reaches the host
// and reports ENOENT.
//
// GNU make uses eaccess() to decide whether a recipe command is executable.
// When it says no, make reports "No such file or directory" and gives up
// without ever forking — observed as a recipe failing with no clone in its
// syscall trace. That broke make's direct-exec path (any recipe or $(shell ...)
// command without shell metacharacters) and with it a kernel build. Mapping the
// path here lets the real eaccess() stat the physical file, which exists.
int euidaccess(const char *path, int mode) {
    typedef int (*fn_t)(const char *, int);
    static _Thread_local fn_t real; REAL(real, "euidaccess");
    if (!real) { errno = ENOSYS; return -1; }
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), mode);
}

int eaccess(const char *path, int mode) {
    typedef int (*fn_t)(const char *, int);
    static _Thread_local fn_t real; REAL(real, "eaccess");
    if (!real) return euidaccess(path, mode);
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), mode);
}

// glibc's stat()/lstat() wrappers are implemented with the statx syscall on
// current kernels, and coreutils calls statx directly when it is available.
int statx(int dirfd, const char *path, int flags, unsigned int mask,
          struct statx *st) {
    typedef int (*fn_t)(int, const char *, int, unsigned int, struct statx *);
    static _Thread_local fn_t real;
    REAL(real, "statx");
    if (!real) { errno = ENOSYS; return -1; }
    char buf[PATH_MAX];
    int rc = real(dirfd, bn_resolve(dirfd, path, buf, sizeof buf), flags, mask, st);
    if (rc == 0 && bn_fake_root()) {
        st->stx_uid = bn_vruid;
        st->stx_gid = bn_vrgid;
    }
    return rc;
}

int faccessat(int dirfd, const char *path, int mode, int flags) {
    typedef int (*fn_t)(int, const char *, int, int);
    static _Thread_local fn_t real; REAL(real, "faccessat");
    char buf[PATH_MAX];
    const char *t = bn_resolve(dirfd, path, buf, sizeof buf);
    return real(dirfd, t, mode, flags);
}

int statvfs(const char *path, struct statvfs *st) {
    typedef int (*fn_t)(const char *, struct statvfs *);
    static _Thread_local fn_t real; REAL(real, "statvfs");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), st);
}

int statvfs64(const char *path, struct statvfs64 *st) {
    typedef int (*fn_t)(const char *, struct statvfs64 *);
    static _Thread_local fn_t real; REAL(real, "statvfs64");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), st);
}

// ── directory and file operations ──────────────────────────────────
int chdir(const char *path) {
    typedef int (*fn_t)(const char *);
    static _Thread_local fn_t real; REAL(real, "chdir");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf));
}

char *getcwd(char *buf, size_t size) {
    typedef char *(*fn_t)(char *, size_t);
    static _Thread_local fn_t real; REAL(real, "getcwd");
    char *r = real(buf, size);
    if (!r) return r;
    char mapped[PATH_MAX];
    const char *logical = bn_unmap(r, mapped, sizeof mapped);
    if (logical == r) return r;
    size_t len = strlen(logical);
    if (buf) {
        if (len >= size) { errno = ERANGE; return NULL; }
        memcpy(buf, logical, len + 1);
        return buf;
    }
    // glibc allocated the result; hand back a guest-sized copy instead.
    char *copy = malloc(len + 1);
    if (!copy) { errno = ENOMEM; free(r); return NULL; }
    memcpy(copy, logical, len + 1);
    free(r);
    return copy;
}

// _FORTIFY_SOURCE rewrites getcwd(buf, sizeof buf) into __getcwd_chk.
char *__getcwd_chk(char *buf, size_t size, size_t buflen) {
    if (size > buflen) __chk_fail();
    return getcwd(buf, size);
}

int chmod(const char *path, mode_t mode) {
    typedef int (*fn_t)(const char *, mode_t);
    static _Thread_local fn_t real; REAL(real, "chmod");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), mode);
}

// coreutils' chmod prefers fchmodat, so this entry point is the one that
// actually matters for dpkg and package maintainer scripts.
int fchmodat(int dirfd, const char *path, mode_t mode, int flags) {
    typedef int (*fn_t)(int, const char *, mode_t, int);
    static _Thread_local fn_t real; REAL(real, "fchmodat");
    char buf[PATH_MAX];
    return real(dirfd, bn_resolve(dirfd, path, buf, sizeof buf), mode, flags);
}

int fchmodat2(int dirfd, const char *path, mode_t mode, int flags) {
    typedef int (*fn_t)(int, const char *, mode_t, int);
    static _Thread_local fn_t real; REAL(real, "fchmodat2");
    if (!real) { errno = ENOSYS; return -1; }
    char buf[PATH_MAX];
    return real(dirfd, bn_resolve(dirfd, path, buf, sizeof buf), mode, flags);
}

int truncate(const char *path, off_t length) {
    typedef int (*fn_t)(const char *, off_t);
    static _Thread_local fn_t real; REAL(real, "truncate");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), length);
}

int truncate64(const char *path, off64_t length) {
    typedef int (*fn_t)(const char *, off64_t);
    static _Thread_local fn_t real; REAL(real, "truncate64");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), length);
}

int mknod(const char *path, mode_t mode, dev_t dev) {
    typedef int (*fn_t)(const char *, mode_t, dev_t);
    static _Thread_local fn_t real; REAL(real, "mknod");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), mode, dev);
}

int mknodat(int dirfd, const char *path, mode_t mode, dev_t dev) {
    typedef int (*fn_t)(int, const char *, mode_t, dev_t);
    static _Thread_local fn_t real; REAL(real, "mknodat");
    char buf[PATH_MAX];
    return real(dirfd, bn_resolve(dirfd, path, buf, sizeof buf), mode, dev);
}

int mkdir(const char *path, mode_t mode) {
    typedef int (*fn_t)(const char *, mode_t);
    static _Thread_local fn_t real; REAL(real, "mkdir");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), mode);
}

int mkdirat(int dirfd, const char *path, mode_t mode) {
    typedef int (*fn_t)(int, const char *, mode_t);
    static _Thread_local fn_t real; REAL(real, "mkdirat");
    char buf[PATH_MAX];
    const char *t = bn_resolve(dirfd, path, buf, sizeof buf);
    return real(dirfd, t, mode);
}

int rmdir(const char *path) {
    typedef int (*fn_t)(const char *);
    static _Thread_local fn_t real; REAL(real, "rmdir");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf));
}

int unlink(const char *path) {
    typedef int (*fn_t)(const char *);
    static _Thread_local fn_t real; REAL(real, "unlink");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf));
}

int unlinkat(int dirfd, const char *path, int flags) {
    typedef int (*fn_t)(int, const char *, int);
    static _Thread_local fn_t real; REAL(real, "unlinkat");
    char buf[PATH_MAX];
    const char *t = bn_resolve(dirfd, path, buf, sizeof buf);
    return real(dirfd, t, flags);
}

int rename(const char *from, const char *to) {
    typedef int (*fn_t)(const char *, const char *);
    static _Thread_local fn_t real; REAL(real, "rename");
    char b1[PATH_MAX], b2[PATH_MAX];
    const char *f = bn_resolve(AT_FDCWD, from, b1, sizeof b1);
    const char *t = bn_resolve(AT_FDCWD, to, b2, sizeof b2);
    return real(f, t);
}

int renameat(int olddirfd, const char *oldpath, int newdirfd, const char *newpath) {
    typedef int (*fn_t)(int, const char *, int, const char *);
    static _Thread_local fn_t real; REAL(real, "renameat");
    char b1[PATH_MAX], b2[PATH_MAX];
    const char *f = bn_resolve(olddirfd, oldpath, b1, sizeof b1);
    const char *t = bn_resolve(newdirfd, newpath, b2, sizeof b2);
    return real(olddirfd, f, newdirfd, t);
}

int renameat2(int olddirfd, const char *oldpath, int newdirfd, const char *newpath,
              unsigned int flags) {
    typedef int (*fn_t)(int, const char *, int, const char *, unsigned int);
    static _Thread_local fn_t real; REAL(real, "renameat2");
    if (!real) { errno = ENOSYS; return -1; }
    char b1[PATH_MAX], b2[PATH_MAX];
    const char *f = bn_resolve(olddirfd, oldpath, b1, sizeof b1);
    const char *t = bn_resolve(newdirfd, newpath, b2, sizeof b2);
    return real(olddirfd, f, newdirfd, t, flags);
}

// Android refuses hard links in practice — `fs.protected_hardlinks`, a FUSE
// mount for shared storage, or vendor SELinux policy — and this holds even for
// a file the caller owns in its own private directory. dpkg keeps a backup of
// the file it is about to replace by linking it, so a refusal breaks apt
// outright.
//
// Falling back to a copy keeps the guarantee the caller actually relies on (the
// old contents survive) and only loses the inode identity. It is attempted only
// for a regular file, where hard-link and copy semantics agree, and never
// silently: the substitution is reported under BIONILUX_DEBUG.
static int bn_copy_file(int fromfd, const char *from, int tofd, const char *to,
                         const struct stat *st) {
    typedef int (*open_fn)(int, const char *, int, ...);
    typedef int (*unlink_fn)(int, const char *, int);
    static _Thread_local open_fn ro;
    static _Thread_local unlink_fn ru;
    REAL(ro, "openat"); REAL(ru, "unlinkat");
    if (!ro || !ru) { errno = ENOSYS; return -1; }
    int in = ro(fromfd, from, O_RDONLY | O_CLOEXEC);
    if (in < 0) return -1;
    int out = ro(tofd, to, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    if (out < 0) { int saved = errno; close(in); errno = saved; return -1; }
    char buf[65536];
    int rc = 0;
    for (;;) {
        ssize_t got = read(in, buf, sizeof buf);
        if (got < 0 && errno == EINTR) continue;
        if (got < 0) { rc = -1; break; }
        if (!got) break;
        ssize_t done = 0;
        while (done < got) {
            ssize_t put = write(out, buf + done, (size_t)(got - done));
            if (put < 0 && errno == EINTR) continue;
            if (put <= 0) { if (!put) errno = EIO; rc = -1; break; }
            done += put;
        }
        if (rc) break;
    }
    if (!rc) rc = fchmod(out, st->st_mode & 07777);
    struct timespec times[] = {st->st_atim, st->st_mtim};
    if (!rc) rc = futimens(out, times);
    int saved = errno;
    close(in);
    if (close(out) < 0 && !rc) { saved = errno; rc = -1; }
    if (rc) ru(tofd, to, 0);
    errno = saved;
    return rc;
}

static int bn_link_or_copy(int fromfd, const char *from, int tofd, const char *to,
                            int flags, int rc, int error) {
    if (rc == 0) return 0;
    if (error != EPERM && error != EACCES && error != EOPNOTSUPP && error != EXDEV) {
        errno = error; return rc;
    }
    typedef int (*stat_fn)(int, const char *, struct stat *, int);
    static _Thread_local stat_fn real;
    REAL(real, "fstatat");
    struct stat st;
    int stat_flags = flags & AT_SYMLINK_FOLLOW ? 0 : AT_SYMLINK_NOFOLLOW;
    // Do not silently turn a hard link to a symlink into a copy of its target.
    if (real && real(fromfd, from, &st, stat_flags) == 0 && S_ISREG(st.st_mode)) {
        int copied = bn_copy_file(fromfd, from, tofd, to, &st);
        if (!copied) DBG("link: copied after kernel refusal: %s -> %s\n", from, to);
        return copied;
    }
    errno = error;
    return rc;
}

int link(const char *from, const char *to) {
    typedef int (*fn_t)(const char *, const char *);
    static _Thread_local fn_t real; REAL(real, "link");
    char b1[PATH_MAX], b2[PATH_MAX];
    const char *f = bn_resolve(AT_FDCWD, from, b1, sizeof b1);
    const char *t = bn_resolve(AT_FDCWD, to, b2, sizeof b2);
    int rc = real(f, t);
    if (rc == 0 || !bn_rootfs()) return rc;
    return bn_link_or_copy(AT_FDCWD, f, AT_FDCWD, t, 0, rc, errno);
}

// An absolute symlink target is stored as its physical path, and readlink()
// maps it back, so the guest always sees the logical target it asked for.
// Storing it verbatim would let a link such as /usr/lib/os-release ->
// /etc/os-release escape the guest at open() time.
static const char *bn_map_symlink_target(const char *target, int dirfd,
                                         const char *linkpath, char *buf, size_t size) {
    if (!target) return target;
    if (!bn_rootfs()) return target;
    if (target[0] == '/') {
        if (bn_under(target, bn_rootfs())) return target;
        return bn_map(target, buf, size);
    }
    if (!bn_has_dotdot(target) || !linkpath || !*linkpath) return target;
    char physical[PATH_MAX];
    if (linkpath[0] == '/') {
        if (strlen(linkpath) >= sizeof physical) return target;
        memcpy(physical, linkpath, strlen(linkpath) + 1);
    } else {
        char base[PATH_MAX];
        if (!bn_dir_base(dirfd, base, sizeof base)) return target;
        int n = snprintf(physical, sizeof physical, "%s/%s", base, linkpath);
        if (n <= 0 || (size_t)n >= sizeof physical) return target;
    }
    char *slash = strrchr(physical, '/');
    if (!slash) return target;
    *slash = '\0';
    if (!bn_under(physical, bn_rootfs())) return target; // authorized host cwd
    char joined[PATH_MAX], norm[PATH_MAX];
    int n = snprintf(joined, sizeof joined, "%s/%s", physical, target);
    if (n <= 0 || (size_t)n >= sizeof joined) return target;
    bn_normalize(joined, norm, sizeof norm);
    if (bn_under(norm, bn_rootfs())) return target; // ordinary relative link

    // The kernel cannot clamp a relative target at the guest root. Store a
    // mapped absolute target only when its lexical .. traversal crosses it.
    char logical[PATH_MAX];
    const char *parent = bn_unmap(physical, logical, sizeof logical);
    n = snprintf(joined, sizeof joined, "%s/%s", parent, target);
    if (n <= 0 || (size_t)n >= sizeof joined) return target;
    bn_normalize(joined, norm, sizeof norm);
    return bn_map(norm, buf, size);
}

int symlink(const char *target, const char *linkpath) {
    typedef int (*fn_t)(const char *, const char *);
    static _Thread_local fn_t real; REAL(real, "symlink");
    char tbuf[PATH_MAX], lbuf[PATH_MAX];
    const char *lp = bn_resolve(AT_FDCWD, linkpath, lbuf, sizeof lbuf);
    const char *tg = bn_map_symlink_target(target, AT_FDCWD, lp, tbuf, sizeof tbuf);
    return real(tg, lp);
}

int symlinkat(const char *target, int dirfd, const char *linkpath) {
    typedef int (*fn_t)(const char *, int, const char *);
    static _Thread_local fn_t real; REAL(real, "symlinkat");
    char tbuf[PATH_MAX], lbuf[PATH_MAX];
    const char *lp = bn_resolve(dirfd, linkpath, lbuf, sizeof lbuf);
    const char *tg = bn_map_symlink_target(target, dirfd, lp, tbuf, sizeof tbuf);
    return real(tg, dirfd, lp);
}

int linkat(int ofd, const char *from, int nfd, const char *to, int flags) {
    typedef int (*fn_t)(int, const char *, int, const char *, int);
    static _Thread_local fn_t real; REAL(real, "linkat");
    char b1[PATH_MAX], b2[PATH_MAX];
    const char *f = bn_resolve(ofd, from, b1, sizeof b1);
    const char *t = bn_resolve(nfd, to, b2, sizeof b2);
    int rc = real(ofd, f, nfd, t, flags);
    if (rc == 0 || !bn_rootfs()) return rc;
    return bn_link_or_copy(ofd, f, nfd, t, flags, rc, errno);
}

int utimensat(int dirfd, const char *path, const struct timespec times[2], int flags) {
    typedef int (*fn_t)(int, const char *, const struct timespec[2], int);
    static _Thread_local fn_t real; REAL(real, "utimensat");
    if (!real) { errno = ENOSYS; return -1; }
    char buf[PATH_MAX];
    const char *t = bn_resolve(dirfd, path, buf, sizeof buf);
    return real(dirfd, t, times, flags);
}

int utimes(const char *path, const struct timeval times[2]) {
    typedef int (*fn_t)(const char *, const struct timeval[2]);
    static _Thread_local fn_t real; REAL(real, "utimes");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), times);
}

int utime(const char *path, const struct utimbuf *times) {
    typedef int (*fn_t)(const char *, const struct utimbuf *);
    static _Thread_local fn_t real; REAL(real, "utime");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), times);
}

// ── readlink / realpath ────────────────────────────────────────────
// The kernel sees the explicitly invoked loader as the executable. Both
// readlink and realpath must expose the original program, including the
// aliases used by libuv and managed language hosts.
static int bn_self_exe(const char *path) {
    if (!path) return 0;
    if (!strcmp(path, "/proc/self/exe") || !strcmp(path, "/proc/thread-self/exe")) return 1;
    char own[64];
    snprintf(own, sizeof own, "/proc/%ld/exe", (long)getpid());
    return !strcmp(path, own);
}

static ssize_t fake_exe(char *buf, size_t size) {
    const char *exe = getenv("BIONILUX_TARGET_EXE");
    if (!exe) return -1;
    if (size == 0) { errno = EINVAL; return -1; }
    size_t len = strlen(exe);
    size_t n = len < size ? len : size;
    memcpy(buf, exe, n);
    return (ssize_t)n;
}

ssize_t readlinkat(int dirfd, const char *path, char *buf, size_t size) {
    typedef ssize_t (*fn_t)(int, const char *, char *, size_t);
    static _Thread_local fn_t real; REAL(real, "readlinkat");
    if (bn_self_exe(path)) {
        ssize_t r = fake_exe(buf, size);
        if (r >= 0) return r;
    }
    if (size == 0) { errno = EINVAL; return -1; }
    char mapped[PATH_MAX], raw[PATH_MAX + 1];
    const char *t = bn_resolve(dirfd, path, mapped, sizeof mapped);
    ssize_t r = real(dirfd, t, raw, PATH_MAX);
    if (r <= 0) return r;
    raw[r] = '\0';
    char logical[PATH_MAX];
    const char *u = bn_unmap(raw, logical, sizeof logical);
    size_t len = strlen(u);
    size_t copy = len < size ? len : size;
    memcpy(buf, u, copy);
    return (ssize_t)copy;
}

ssize_t readlink(const char *path, char *buf, size_t size) {
    return readlinkat(AT_FDCWD, path, buf, size);
}

ssize_t __readlink_chk(const char *path, char *buf, size_t size, size_t buflen) {
    if (size > buflen) __chk_fail();
    return readlink(path, buf, size);
}

ssize_t __readlinkat_chk(int dirfd, const char *path, char *buf, size_t size, size_t buflen) {
    if (size > buflen) __chk_fail();
    return readlinkat(dirfd, path, buf, size);
}

char *realpath(const char *path, char *resolved) {
    typedef char *(*fn_t)(const char *, char *);
    static _Thread_local fn_t real; REAL(real, "realpath");
    if (bn_self_exe(path)) {
        const char *exe = getenv("BIONILUX_TARGET_EXE");
        if (exe && *exe) path = exe;
    }
    char buf[PATH_MAX];
    char *r = real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), resolved);
    if (!r) return r;
    char logical[PATH_MAX];
    const char *u = bn_unmap(r, logical, sizeof logical);
    if (u == r) return r;
    size_t len = strlen(logical);
    if (resolved) {
        memcpy(resolved, logical, len + 1);
        return resolved;
    }
    // glibc allocated the result; hand back a guest-sized copy instead.
    char *copy = malloc(len + 1);
    if (!copy) { free(r); errno = ENOMEM; return NULL; }
    memcpy(copy, logical, len + 1);
    free(r);
    return copy;
}

// uname's machine field describes the guest ABI, rather than an Android
// native bridge's underlying kernel. Keep all other kernel fields intact.
int uname(struct utsname *name) {
    typedef int (*fn_t)(struct utsname *);
    static _Thread_local fn_t real; REAL(real, "uname");
    int rc = real(name);
    if (rc == 0 && bn_rootfs()) {
#if defined(__x86_64__)
        snprintf(name->machine, sizeof name->machine, "x86_64");
#elif defined(__aarch64__)
        snprintf(name->machine, sizeof name->machine, "aarch64");
#endif
    }
    return rc;
}

// _FORTIFY_SOURCE rewrites realpath(path, buf) into __realpath_chk. Debian and
// Ubuntu enable fortification by default, so this entry point matters as much
// as realpath itself.
char *__realpath_chk(const char *path, char *resolved, size_t resolvedlen) {
    char *logical = realpath(path, NULL);
    if (!logical) return NULL;
    size_t len = strlen(logical) + 1;
    if (len > resolvedlen) { free(logical); __chk_fail(); }
    memcpy(resolved, logical, len);
    free(logical);
    return resolved;
}

// ── fake root and virtual identity ─────────────────────────────────
// apt and dpkg check the effective uid before doing anything and refuse to
// run otherwise; on Android the app's uid can never be 0. Reporting 0 is what
// makes a Debian user space usable at all.
//
// The identity is *virtual*: setuid()/setgid() cannot actually take effect, so
// they record the requested ids and getuid()/getgid() report them back. apt
// verifies the switch it just made, and a stub that always answers 0 would
// fail that check with "Could not switch group". Ownership changes become
// no-ops, because every file already belongs to the app's own uid.
// The variables themselves are declared next to bn_fake_root().

uid_t getuid(void) {
    typedef uid_t (*fn_t)(void);
    static _Thread_local fn_t real; REAL(real, "getuid");
    return bn_fake_root() ? bn_vruid : real();
}

uid_t geteuid(void) {
    typedef uid_t (*fn_t)(void);
    static _Thread_local fn_t real; REAL(real, "geteuid");
    return bn_fake_root() ? bn_veuid : real();
}

gid_t getgid(void) {
    typedef gid_t (*fn_t)(void);
    static _Thread_local fn_t real; REAL(real, "getgid");
    return bn_fake_root() ? bn_vrgid : real();
}

gid_t getegid(void) {
    typedef gid_t (*fn_t)(void);
    static _Thread_local fn_t real; REAL(real, "getegid");
    return bn_fake_root() ? bn_vegid : real();
}

int getresuid(uid_t *r, uid_t *e, uid_t *s) {
    if (!bn_fake_root()) {
        typedef int (*fn_t)(uid_t *, uid_t *, uid_t *);
        static _Thread_local fn_t real; REAL(real, "getresuid");
        return real(r, e, s);
    }
    if (r) *r = bn_vruid;
    if (e) *e = bn_veuid;
    if (s) *s = bn_vsuid;
    return 0;
}

int getresgid(gid_t *r, gid_t *e, gid_t *s) {
    if (!bn_fake_root()) {
        typedef int (*fn_t)(gid_t *, gid_t *, gid_t *);
        static _Thread_local fn_t real; REAL(real, "getresgid");
        return real(r, e, s);
    }
    if (r) *r = bn_vrgid;
    if (e) *e = bn_vegid;
    if (s) *s = bn_vsgid;
    return 0;
}

// -1 in a setres* argument means "leave unchanged", per POSIX.
static void bn_set_uid(uid_t r, uid_t e, uid_t s) {
    if (r != (uid_t)-1) bn_vruid = r;
    if (e != (uid_t)-1) bn_veuid = e;
    if (s != (uid_t)-1) bn_vsuid = s;
}

static void bn_set_gid(gid_t r, gid_t e, gid_t s) {
    if (r != (gid_t)-1) bn_vrgid = r;
    if (e != (gid_t)-1) bn_vegid = e;
    if (s != (gid_t)-1) bn_vsgid = s;
}

int setuid(uid_t uid) {
    if (!bn_fake_root()) { errno = EPERM; return -1; }
    bn_set_uid(uid, uid, uid);
    return 0;
}

int seteuid(uid_t uid) {
    if (!bn_fake_root()) { errno = EPERM; return -1; }
    bn_veuid = uid;
    return 0;
}

int setreuid(uid_t r, uid_t e) {
    if (!bn_fake_root()) { errno = EPERM; return -1; }
    bn_set_uid(r, e, (uid_t)-1);
    return 0;
}

int setresuid(uid_t r, uid_t e, uid_t s) {
    if (!bn_fake_root()) { errno = EPERM; return -1; }
    bn_set_uid(r, e, s);
    return 0;
}

int setgid(gid_t gid) {
    if (!bn_fake_root()) { errno = EPERM; return -1; }
    bn_set_gid(gid, gid, gid);
    return 0;
}

int setegid(gid_t gid) {
    if (!bn_fake_root()) { errno = EPERM; return -1; }
    bn_vegid = gid;
    return 0;
}

int setregid(gid_t r, gid_t e) {
    if (!bn_fake_root()) { errno = EPERM; return -1; }
    bn_set_gid(r, e, (gid_t)-1);
    return 0;
}

int setresgid(gid_t r, gid_t e, gid_t s) {
    if (!bn_fake_root()) { errno = EPERM; return -1; }
    bn_set_gid(r, e, s);
    return 0;
}

// apt's http method drops privileges before fetching, and reports "Could not
// switch group" when these fail. Supplementary groups cannot be changed, so
// they succeed as no-ops for the same reason the uid is virtual.
int setgroups(size_t size, const gid_t *list) {
    (void)size; (void)list;
    if (bn_fake_root()) return 0;
    errno = EPERM;
    return -1;
}

int initgroups(const char *user, gid_t group) {
    (void)user; (void)group;
    if (bn_fake_root()) return 0;
    errno = EPERM;
    return -1;
}

int chown(const char *path, uid_t uid, gid_t gid) {
    typedef int (*fn_t)(const char *, uid_t, gid_t);
    static _Thread_local fn_t real; REAL(real, "chown");
    char buf[PATH_MAX];
    const char *t = bn_resolve(AT_FDCWD, path, buf, sizeof buf);
    if (bn_fake_root()) { (void)uid; (void)gid; return 0; }
    return real(t, uid, gid);
}

int lchown(const char *path, uid_t uid, gid_t gid) {
    typedef int (*fn_t)(const char *, uid_t, gid_t);
    static _Thread_local fn_t real; REAL(real, "lchown");
    char buf[PATH_MAX];
    const char *t = bn_resolve(AT_FDCWD, path, buf, sizeof buf);
    if (bn_fake_root()) { (void)uid; (void)gid; return 0; }
    return real(t, uid, gid);
}

int fchown(int fd, uid_t uid, gid_t gid) {
    typedef int (*fn_t)(int, uid_t, gid_t);
    static _Thread_local fn_t real; REAL(real, "fchown");
    if (bn_fake_root()) { (void)uid; (void)gid; return 0; }
    return real(fd, uid, gid);
}

int fchownat(int dirfd, const char *path, uid_t uid, gid_t gid, int flags) {
    typedef int (*fn_t)(int, const char *, uid_t, gid_t, int);
    static _Thread_local fn_t real; REAL(real, "fchownat");
    char buf[PATH_MAX];
    const char *t = bn_resolve(dirfd, path, buf, sizeof buf);
    if (bn_fake_root()) { (void)uid; (void)gid; return 0; }
    return real(dirfd, t, uid, gid, flags);
}

// ── mkstemp and friends ────────────────────────────────────────────
// glibc creates the temporary file with an internal openat() that cannot be
// interposed, so an absolute template would be created on the *host*. apt
// builds its package caches this way, which shows up as a rename() failure
// between a host temp file and a guest destination.
//
// These wrappers create the file themselves through the mapped path. The
// caller's template keeps its logical spelling, so later rename() and
// unlink() calls on it map the same way and the guest never sees a physical
// path.
static int bn_mkstemp_at(char *tmpl, int extra_flags, int suffixlen) {
    typedef int (*fn_t)(char *, int, int);
    static _Thread_local fn_t real; REAL(real, "mkostemps");
    if (!real) { errno = ENOSYS; return -1; }
    size_t len = strlen(tmpl);
    if (suffixlen < 0 || len < 6 || (size_t)suffixlen > len - 6) {
        errno = EINVAL; return -1;
    }
    char mapped[PATH_MAX];
    const char *target = bn_resolve(AT_FDCWD, tmpl, mapped, sizeof mapped);
    char *physical = strdup(target);
    if (!physical) return -1;
    int fd = real(physical, suffixlen, extra_flags);
    int saved = errno;
    if (fd >= 0) memcpy(tmpl + len - suffixlen - 6,
                        physical + strlen(physical) - suffixlen - 6, 6);
    free(physical);
    errno = saved;
    return fd;
}

int mkstemp(char *tmpl) { return bn_mkstemp_at(tmpl, 0, 0); }
int mkostemp(char *tmpl, int flags) { return bn_mkstemp_at(tmpl, flags, 0); }
int mkstemps(char *tmpl, int suffixlen) { return bn_mkstemp_at(tmpl, 0, suffixlen); }
int mkostemps(char *tmpl, int suffixlen, int flags) {
    return bn_mkstemp_at(tmpl, flags, suffixlen);
}

// The _FILE_OFFSET_BITS=64 spellings are separate symbols rather than header
// aliases, so a program built against them — git imports mkstemp64() — would
// otherwise reach the host through the variant we had not hooked.
int mkstemp64(char *tmpl) { return bn_mkstemp_at(tmpl, 0, 0); }
int mkostemp64(char *tmpl, int flags) { return bn_mkstemp_at(tmpl, flags, 0); }
int mkstemps64(char *tmpl, int suffixlen) { return bn_mkstemp_at(tmpl, 0, suffixlen); }
int mkostemps64(char *tmpl, int suffixlen, int flags) {
    return bn_mkstemp_at(tmpl, flags, suffixlen);
}

// ── remaining path-taking entry points ─────────────────────────────
// libc has a few more public functions that take a path and resolve it
// internally, so an unmapped argument would reach the host file system with
// the guest's spelling. dpkg alone uses lutimes(), mkfifo(), mkdtemp(),
// scandir() and statfs(), and one unmapped call aborts a package installation:
// without lutimes() the symlink members of a package fail with
// `error setting timestamps of '.../liblzma.so.5.dpkg-new': No such file or
// directory`, because the timestamp call went to the host root.

#include <dirent.h>
#include <sys/statfs.h>

int lutimes(const char *path, const struct timeval times[2]) {
    typedef int (*fn_t)(const char *, const struct timeval[2]);
    static _Thread_local fn_t real; REAL(real, "lutimes");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), times);
}

int mkfifo(const char *path, mode_t mode) {
    typedef int (*fn_t)(const char *, mode_t);
    static _Thread_local fn_t real; REAL(real, "mkfifo");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), mode);
}

int mkfifoat(int dirfd, const char *path, mode_t mode) {
    typedef int (*fn_t)(int, const char *, mode_t);
    static _Thread_local fn_t real; REAL(real, "mkfifoat");
    char buf[PATH_MAX];
    return real(dirfd, bn_resolve(dirfd, path, buf, sizeof buf), mode);
}

// glibc's mkdtemp creates the directory with an internal mkdir(), which our
// hook cannot see, so an absolute template would create it on the host. Create
// it here instead, through the mapped path, and keep the caller's template
// logical so later calls on it map the same way.
char *mkdtemp(char *tmpl) {
    typedef char *(*fn_t)(char *);
    static _Thread_local fn_t real; REAL(real, "mkdtemp");
    if (!real) { errno = ENOSYS; return NULL; }
    size_t len = strlen(tmpl);
    if (len < 6) { errno = EINVAL; return NULL; }
    char mapped[PATH_MAX];
    const char *target = bn_resolve(AT_FDCWD, tmpl, mapped, sizeof mapped);
    char *physical = strdup(target);
    if (!physical) return NULL;
    char *result = real(physical);
    int saved = errno;
    if (result) memcpy(tmpl + len - 6, physical + strlen(physical) - 6, 6);
    free(physical);
    errno = saved;
    return result ? tmpl : NULL;
}

int scandir(const char *path, struct dirent ***namelist,
            int (*filter)(const struct dirent *),
            int (*compar)(const struct dirent **, const struct dirent **)) {
    typedef int (*fn_t)(const char *, struct dirent ***, int (*)(const struct dirent *),
                        int (*)(const struct dirent **, const struct dirent **));
    static _Thread_local fn_t real; REAL(real, "scandir");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), namelist, filter, compar);
}

int statfs(const char *path, struct statfs *st) {
    typedef int (*fn_t)(const char *, struct statfs *);
    static _Thread_local fn_t real; REAL(real, "statfs");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), st);
}

int statfs64(const char *path, struct statfs64 *st) {
    typedef int (*fn_t)(const char *, struct statfs64 *);
    static _Thread_local fn_t real; REAL(real, "statfs64");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), st);
}

int remove(const char *path) {
    typedef int (*fn_t)(const char *);
    static _Thread_local fn_t real; REAL(real, "remove");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf));
}

int lchmod(const char *path, mode_t mode) {
    typedef int (*fn_t)(const char *, mode_t);
    static _Thread_local fn_t real; REAL(real, "lchmod");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), mode);
}

int scandirat(int dirfd, const char *path, struct dirent ***namelist,
              int (*filter)(const struct dirent *),
              int (*compar)(const struct dirent **, const struct dirent **)) {
    typedef int (*fn_t)(int, const char *, struct dirent ***,
                        int (*)(const struct dirent *),
                        int (*)(const struct dirent **, const struct dirent **));
    static _Thread_local fn_t real; REAL(real, "scandirat");
    char buf[PATH_MAX];
    return real(dirfd, bn_resolve(dirfd, path, buf, sizeof buf), namelist, filter, compar);
}

int scandir64(const char *path, struct dirent64 ***namelist,
              int (*filter)(const struct dirent64 *),
              int (*compar)(const struct dirent64 **, const struct dirent64 **)) {
    typedef int (*fn_t)(const char *, struct dirent64 ***,
                        int (*)(const struct dirent64 *),
                        int (*)(const struct dirent64 **, const struct dirent64 **));
    static _Thread_local fn_t real; REAL(real, "scandir64");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), namelist, filter, compar);
}

// A file action holds a path that the spawned child will open or chdir to. The
// child is the launcher, which expects a physical path, so the guest path has
// to be mapped here — the action object is opaque and cannot be fixed later.
int posix_spawn_file_actions_addopen(posix_spawn_file_actions_t *fa, int fd,
                                     const char *path, int oflag, mode_t mode) {
    typedef int (*fn_t)(posix_spawn_file_actions_t *, int, const char *, int, mode_t);
    static _Thread_local fn_t real; REAL(real, "posix_spawn_file_actions_addopen");
    if (!real) return ENOSYS;
    char buf[PATH_MAX];
    return real(fa, fd, bn_resolve(AT_FDCWD, path, buf, sizeof buf), oflag, mode);
}

int posix_spawn_file_actions_addchdir_np(posix_spawn_file_actions_t *fa,
                                         const char *path) {
    typedef int (*fn_t)(posix_spawn_file_actions_t *, const char *);
    static _Thread_local fn_t real; REAL(real, "posix_spawn_file_actions_addchdir_np");
    if (!real) return ENOSYS;
    char buf[PATH_MAX];
    return real(fa, bn_resolve(AT_FDCWD, path, buf, sizeof buf));
}

// ── getifaddrs fallback via SIOCGIFCONF ────────────────────────────
// Android's SELinux blocks the netlink RTM_GETLINK query glibc's
// getifaddrs uses, so it returns EACCES. WebRTC/ICE needs the local
// interface list to build candidates; without it, connections to
// BDS hang at "Connecting to multiplayer game". ioctl(SIOCGIFCONF)
// is still permitted and gives us the IPv4 interfaces.
struct bn_ifa {
    struct ifaddrs ifa;
    char name[IFNAMSIZ];
    struct sockaddr_in addr, mask;
};

static int fallback_getifaddrs(struct ifaddrs **ifap) {
    int s = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
    if (s < 0) return -1;

    struct ifreq reqs[32];
    struct ifconf ic;
    memset(&ic, 0, sizeof ic);
    ic.ifc_len = sizeof reqs;
    ic.ifc_req = reqs;
    if (ioctl(s, SIOCGIFCONF, &ic) < 0) {
        int e = errno; close(s); errno = e; return -1;
    }

    int n = ic.ifc_len / (int)sizeof(struct ifreq);
    struct bn_ifa *arr = calloc(n ? n : 1, sizeof *arr);
    if (!arr) { close(s); errno = ENOMEM; return -1; }

    int k = 0;
    for (int i = 0; i < n; i++) {
        if (reqs[i].ifr_addr.sa_family != AF_INET) continue;
        struct bn_ifa *e = &arr[k];

        memcpy(e->name, reqs[i].ifr_name, IFNAMSIZ - 1);
        memcpy(&e->addr, &reqs[i].ifr_addr, sizeof e->addr);

        struct ifreq q;
        memset(&q, 0, sizeof q);
        memcpy(q.ifr_name, e->name, IFNAMSIZ - 1);
        unsigned flags = 0;
        if (ioctl(s, SIOCGIFFLAGS, &q) == 0)
            flags = (unsigned short)q.ifr_flags;
        if (!(flags & IFF_UP)) continue;

        memset(&q, 0, sizeof q);
        memcpy(q.ifr_name, e->name, IFNAMSIZ - 1);
        if (ioctl(s, SIOCGIFNETMASK, &q) == 0)
            memcpy(&e->mask, &q.ifr_netmask, sizeof e->mask);

        e->ifa.ifa_name    = e->name;
        e->ifa.ifa_flags   = flags;
        e->ifa.ifa_addr    = (struct sockaddr *)&e->addr;
        e->ifa.ifa_netmask = (struct sockaddr *)&e->mask;
        if (k > 0) arr[k - 1].ifa.ifa_next = &e->ifa;
        k++;
    }
    close(s);

    if (k == 0) { free(arr); *ifap = NULL; return 0; }
    *ifap = &arr[0].ifa;
    return 0;
}

int getifaddrs(struct ifaddrs **ifap) {
    typedef int (*fn_t)(struct ifaddrs **);
    static _Thread_local fn_t real;
    REAL(real, "getifaddrs");

    int r = real ? real(ifap) : -1;
    int e = errno;

    if (r != 0) {
        DBG("getifaddrs real failed (errno=%d), using SIOCGIFCONF fallback\n", e);
        r = fallback_getifaddrs(ifap);
        e = errno;
    }

    if (bionilux_debug() && r == 0) {
        for (struct ifaddrs *i = *ifap; i; i = i->ifa_next) {
            char ip[INET6_ADDRSTRLEN] = "-";
            if (i->ifa_addr && i->ifa_addr->sa_family == AF_INET)
                inet_ntop(AF_INET, &((struct sockaddr_in *)i->ifa_addr)->sin_addr, ip, sizeof ip);
            DBG("  if=%s fam=%d addr=%s\n", i->ifa_name,
                i->ifa_addr ? i->ifa_addr->sa_family : -1, ip);
        }
    } else if (r != 0) {
        DBG("getifaddrs fallback failed (errno=%d)\n", e);
    }
    errno = e;
    return r;
}

// ── guest name resolution ──────────────────────────────────────────
// glibc reads /etc/resolv.conf and the NSS databases through internal aliases
// that never cross the PLT, so inside a rootfs it silently uses the *host's*
// files (and on Android the host has no /etc/resolv.conf at all). Without a
// nameserver it falls back to its compiled-in default, 127.0.0.1:53, where
// nothing listens, so every lookup fails with EAI_AGAIN while raw UDP to the
// device's real resolvers works fine.
//
// The guest's own configuration *is* reachable through our hooks, so the public
// resolver entry points are answered here from the guest's files. Everything
// else is left to glibc: addresses are handed back as numeric strings and glibc
// still builds the result list, so service names, socket types, protocols and
// ordering keep their normal semantics.

#include <arpa/inet.h>
#include <netdb.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/stat.h>

#define BN_DNS_MAXSRV 4
#define BN_DNS_MAXV4 8
#define BN_DNS_MAXV6 4
#define BN_DNS_MAXSEARCH 4

typedef struct {
    int v4_count, v6_count;
    struct in_addr v4[BN_DNS_MAXV4];
    struct in6_addr v6[BN_DNS_MAXV6];
    int rcode;      // DNS rcode, or -1 when no server answered
} bn_answer;

typedef struct {
    int loaded;
    int rootfs_version;      // invalidates the cache when --rootfs changes
    unsigned long mtime;     // of the guest's resolv.conf
    unsigned long mtime_nsec;
    int check_countdown;
    int server_count;
    struct sockaddr_in server[BN_DNS_MAXSRV];
    int timeout_ms;
    int attempts;
    int ndots;
    int search_count;
    char search[BN_DNS_MAXSEARCH][256];
} bn_dns_config;

static _Thread_local bn_dns_config bn_dns;

// Whether guest resolution applies at all. Without --rootfs the process is a
// plain Android one and libc's own behaviour must be left untouched.
static int bn_dns_enabled(void) {
    static int cached = -1;
    if (cached < 0) {
        const char *off = bn_env("BIONILUX_DNS");
        cached = (bn_rootfs() != NULL) && !(off && strcmp(off, "0") == 0);
    }
    return cached;
}

// Read a guest file through the mapping, using the real (unhooked) entry points.
static ssize_t bn_read_guest(const char *guest, char *buf, size_t cap) {
    typedef int (*open_fn)(const char *, int, ...);
    typedef ssize_t (*read_fn)(int, void *, size_t);
    static _Thread_local open_fn ro; static _Thread_local read_fn rr;
    REAL(ro, "open"); REAL(rr, "read");
    if (!ro || !rr || cap == 0) return -1;

    char path[PATH_MAX];
    int fd = ro(bn_map(guest, path, sizeof path), O_RDONLY);
    if (fd < 0) return -1;
    ssize_t got = rr(fd, buf, cap - 1);
    int e = errno;
    typedef int (*close_fn)(int);
    static _Thread_local close_fn rc; REAL(rc, "close");
    if (rc) rc(fd);
    errno = e;
    if (got < 0) return -1;
    buf[got] = '\0';
    return got;
}

// st_mtim is glibc's; keep one spelling so the loader does not depend on macros.
static void bn_mtime_of(const char *guest, unsigned long *sec, unsigned long *nsec) {
    typedef int (*stat_fn)(const char *, struct stat *);
    static _Thread_local stat_fn rs; REAL(rs, "stat");
    char path[PATH_MAX];
    struct stat st;
    *sec = 0; *nsec = 0;
    if (!rs) return;
    if (rs(bn_map(guest, path, sizeof path), &st) == 0) {
        *sec = (unsigned long)st.st_mtim.tv_sec;
        *nsec = (unsigned long)st.st_mtim.tv_nsec;
    }
}

static void bn_dns_add_server(bn_dns_config *c, struct in_addr v4) {
    if (c->server_count >= BN_DNS_MAXSRV) return;
    struct sockaddr_in *s = &c->server[c->server_count++];
    memset(s, 0, sizeof *s);
    s->sin_family = AF_INET;
    s->sin_port = htons(53);
    s->sin_addr = v4;
}

// Longest-prefix-free parse of the guest's resolver configuration. Only the
// options that change how a lookup is performed are honoured.
static void bn_dns_parse_config(bn_dns_config *c, char *text) {
    char *save = NULL;
    for (char *line = strtok_r(text, "\n", &save); line;
         line = strtok_r(NULL, "\n", &save)) {
        while (*line == ' ' || *line == '\t' || *line == '\r') line++;
        if (*line == '#' || *line == ';' || !*line) continue;

        char *arg = line;
        while (*arg && *arg != ' ' && *arg != '\t') arg++;
        int more = *arg != '\0';
        if (more) *arg++ = '\0';
        while (*arg == ' ' || *arg == '\t') arg++;

        if (strcmp(line, "nameserver") == 0 && more) {
            struct in_addr v4;
            if (inet_pton(AF_INET, arg, &v4) == 1)
                bn_dns_add_server(c, v4);
            // IPv6 nameservers are ignored: a working IPv4 resolver is
            // universally available on Android and is enough for the lookup.
        } else if (strcmp(line, "options") == 0 && more) {
            char *s2 = NULL;
            for (char *o = strtok_r(arg, " \t", &s2); o; o = strtok_r(NULL, " \t", &s2)) {
                if (!strncmp(o, "timeout:", 8)) {
                    long v = strtol(o + 8, NULL, 10);
                    if (v > 0) c->timeout_ms = (v > 30 ? 30 : (int)v) * 1000;
                } else if (!strncmp(o, "attempts:", 9)) {
                    long v = strtol(o + 9, NULL, 10);
                    if (v > 0) c->attempts = v > 5 ? 5 : (int)v;
                } else if (!strncmp(o, "ndots:", 6)) {
                    long v = strtol(o + 6, NULL, 10);
                    if (v >= 0) c->ndots = v > 15 ? 15 : (int)v;
                }
            }
        } else if ((strcmp(line, "search") == 0 || strcmp(line, "domain") == 0) && more) {
            char *s2 = NULL;
            for (char *d = strtok_r(arg, " \t", &s2); d; d = strtok_r(NULL, " \t", &s2)) {
                if (c->search_count >= BN_DNS_MAXSEARCH) break;
                snprintf(c->search[c->search_count], sizeof c->search[0], "%s", d);
                c->search_count++;
            }
        }
    }
}

static void bn_dns_load(int force) {
    int version = bn_rootfs() ? (int)strlen(bn_rootfs()) : -1;
    unsigned long sec = 0, nsec = 0;
    bn_mtime_of("/etc/resolv.conf", &sec, &nsec);
    if (bn_dns.loaded && bn_dns.rootfs_version == version && !force &&
        sec == bn_dns.mtime && nsec == bn_dns.mtime_nsec)
        return;

    memset(&bn_dns, 0, sizeof bn_dns);
    bn_dns.loaded = 1;
    bn_dns.rootfs_version = version;
    bn_dns.mtime = sec;
    bn_dns.mtime_nsec = nsec;
    bn_dns.timeout_ms = 5000;
    bn_dns.attempts = 2;
    bn_dns.ndots = 1;

    char text[4096];
    if (bn_read_guest("/etc/resolv.conf", text, sizeof text) > 0)
        bn_dns_parse_config(&bn_dns, text);

    // The launcher may know better (it can see Android's per-network resolvers,
    // which are not in any file we can read from inside the guest).
    const char *env = bn_env("BIONILUX_DNS_SERVERS");
    if (env) {
        int had = 0;
        char *s2 = NULL;
        char copy[512];
        snprintf(copy, sizeof copy, "%s", env);
        for (char *t = strtok_r(copy, ", \t", &s2); t; t = strtok_r(NULL, ", \t", &s2)) {
            struct in_addr v4;
            if (inet_pton(AF_INET, t, &v4) == 1) {
                if (!had) { bn_dns.server_count = 0; had = 1; }
                bn_dns_add_server(&bn_dns, v4);
            }
        }
    }

    DBG("dns: servers=%d timeout=%dms attempts=%d search=%d\n", bn_dns.server_count,
        bn_dns.timeout_ms, bn_dns.attempts, bn_dns.search_count);
    for (int i = 0; i < bn_dns.server_count; i++) {
        char ip[INET_ADDRSTRLEN] = "?";
        inet_ntop(AF_INET, &bn_dns.server[i].sin_addr, ip, sizeof ip);
        DBG("dns: server[%d]=%s\n", i, ip);
    }
}

// Check the configuration every 64 lookups, without a stat on every lookup.
// Each thread owns its resolver snapshot, so refresh cannot race another query.
static void bn_dns_refresh(void) {
    if (bn_dns.check_countdown-- > 0) return;
    bn_dns.check_countdown = 64;
    bn_dns_load(0);
}

// ── wire format ────────────────────────────────────────────────────
static int bn_dns_build(unsigned char *buf, size_t cap, const char *name, uint16_t id, int qtype) {
    size_t n = 12;
    const char *p = name;
    if (cap < 17) return -1;

    buf[0] = (unsigned char)(id >> 8);
    buf[1] = (unsigned char)(id & 0xff);
    buf[2] = 0x01;  // recursion desired
    buf[3] = 0x00;
    buf[4] = 0x00; buf[5] = 0x01;
    memset(buf + 6, 0, 6);

    while (*p) {
        const char *dot = strchr(p, '.');
        size_t len = dot ? (size_t)(dot - p) : strlen(p);
        if (len == 0 || len > 63 || len + 6 > cap - n || n + len + 2 > 267) return -1;
        buf[n++] = (unsigned char)len;
        memcpy(buf + n, p, len);
        n += len;
        if (!dot) break;
        p = dot + 1;
    }
    buf[n++] = 0x00;
    buf[n++] = (unsigned char)(qtype >> 8);
    buf[n++] = (unsigned char)(qtype & 0xff);
    buf[n++] = 0x00; buf[n++] = 0x01;   // class IN
    return (int)n;
}

static int bn_dns_skip_name(const unsigned char *b, int len, int *off) {
    int o = *off;
    while (o < len) {
        unsigned char c = b[o];
        if (c == 0x00) { o++; break; }
        if ((c & 0xc0) == 0xc0) { o += 2; break; }
        o += 1 + (int)c;
    }
    if (o > len) return -1;
    *off = o;
    return 0;
}

// Parse a reply into addresses. Returns 0 when the reply is a well-formed
// answer to our query, -1 otherwise (including mismatched ids).
static int bn_dns_parse(const unsigned char *b, int len, uint16_t id, int qtype, bn_answer *out) {
    if (len < 12) return -1;
    if ((((unsigned)b[0] << 8) | b[1]) != id) return -1;
    if (!(b[2] & 0x80)) return -1;              // must be a response

    out->rcode = b[3] & 0x0f;
    unsigned qd = ((unsigned)b[4] << 8) | b[5];
    unsigned an = ((unsigned)b[6] << 8) | b[7];

    int off = 12;
    for (unsigned i = 0; i < qd; i++) {
        if (bn_dns_skip_name(b, len, &off) < 0 || off + 4 > len) return -1;
        off += 4;
    }
    for (unsigned i = 0; i < an; i++) {
        unsigned type, rdlen;
        if (bn_dns_skip_name(b, len, &off) < 0 || off + 10 > len) return -1;
        type = ((unsigned)b[off] << 8) | b[off + 1];
        rdlen = ((unsigned)b[off + 8] << 8) | b[off + 9];
        off += 10;
        if (off + (int)rdlen > len) return -1;
        if (type == 1 && rdlen == 4 && qtype == 1 && out->v4_count < BN_DNS_MAXV4)
            memcpy(&out->v4[out->v4_count++], b + off, 4);
        else if (type == 28 && rdlen == 16 && qtype == 28 && out->v6_count < BN_DNS_MAXV6)
            memcpy(&out->v6[out->v6_count++], b + off, 16);
        off += (int)rdlen;
    }
    return 0;
}

static uint16_t bn_dns_id(void) {
    uint16_t id;
    if (getrandom(&id, sizeof id, GRND_NONBLOCK) == sizeof id) return id;
    static _Thread_local uint16_t next = 0x1234;
    return (uint16_t)(next++ ^ (uint16_t)getpid());
}

// One UDP attempt against one server.
static int bn_dns_udp(const struct sockaddr_in *srv, const unsigned char *q, int qlen,
                      unsigned char *r, int rcap, int timeout_ms) {
    typedef int (*sock_fn)(int, int, int);
    typedef int (*conn_fn)(int, const struct sockaddr *, socklen_t);
    typedef ssize_t (*send_fn)(int, const void *, size_t, int);
    typedef ssize_t (*recv_fn)(int, void *, size_t, int);
    typedef int (*poll_fn)(struct pollfd *, nfds_t, int);
    typedef int (*close_fn)(int);
    static _Thread_local sock_fn rs; static _Thread_local conn_fn rc_; static _Thread_local send_fn rsnd; static _Thread_local recv_fn rrc;
    static _Thread_local poll_fn rpoll; static _Thread_local close_fn rcl; static int warned;
    REAL(rs, "socket"); REAL(rc_, "connect"); REAL(rsnd, "send"); REAL(rrc, "recv");
    REAL(rpoll, "poll"); REAL(rcl, "close");
    if (!rs || !rc_ || !rsnd || !rrc || !rpoll) {
        if (!warned++) DBG("dns: socket entry points unavailable\n");
        return -1;
    }

    int fd = rs(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
    if (fd < 0) return -1;
    int rc = rc_(fd, (const struct sockaddr *)srv, sizeof *srv);
    if (rc == 0) rc = (int)(rsnd(fd, q, (size_t)qlen, 0) == (ssize_t)qlen ? 0 : -1);
    if (rc == 0) {
        struct pollfd pfd;
        pfd.fd = fd;
        pfd.events = POLLIN;
        if (rpoll(&pfd, 1, timeout_ms) <= 0) rc = -1;
    }
    int got = -1;
    if (rc == 0) {
        got = (int)rrc(fd, r, (size_t)rcap, 0);
        if (got < 0) got = -1;
    }
    if (rcl) rcl(fd);
    return got;
}

static int64_t bn_dns_now(void) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static int bn_dns_ready(int fd, short events, int64_t deadline) {
    for (;;) {
        int64_t left = deadline - bn_dns_now();
        if (left <= 0) { errno = ETIMEDOUT; return -1; }
        struct pollfd pfd = {.fd = fd, .events = events};
        int rc = poll(&pfd, 1, left > INT_MAX ? INT_MAX : (int)left);
        if (rc > 0) return 0;
        if (rc == 0) { errno = ETIMEDOUT; return -1; }
        if (errno != EINTR) return -1;
    }
}

static int bn_dns_transfer(int fd, void *buf, size_t size, int writing, int64_t deadline) {
    size_t done = 0;
    while (done < size) {
        if (bn_dns_ready(fd, writing ? POLLOUT : POLLIN, deadline) < 0) return -1;
        ssize_t n = writing ? send(fd, (char *)buf + done, size - done, MSG_NOSIGNAL)
                            : recv(fd, (char *)buf + done, size - done, 0);
        if (n < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) continue;
        if (n <= 0) return -1;
        done += (size_t)n;
    }
    return 0;
}

// One deadline covers connect, partial writes, the length prefix and the body.
// A connected DNS peer must not hang a long-lived agent indefinitely.
static int bn_dns_tcp(const struct sockaddr_in *srv, const unsigned char *q, int qlen,
                      unsigned char *r, int rcap, int timeout_ms) {
    int fd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
    if (fd < 0) return -1;
    int64_t deadline = bn_dns_now() + timeout_ms;
    int rc = connect(fd, (const struct sockaddr *)srv, sizeof *srv);
    if (rc < 0 && errno == EINPROGRESS) {
        rc = bn_dns_ready(fd, POLLOUT, deadline);
        if (rc == 0) {
            int error = 0;
            socklen_t len = sizeof error;
            rc = getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &len);
            if (rc == 0 && error) { errno = error; rc = -1; }
        }
    }
    unsigned char head[2] = {(unsigned char)(qlen >> 8), (unsigned char)qlen};
    int got = -1;
    if (rc == 0 && bn_dns_transfer(fd, head, 2, 1, deadline) == 0 &&
        bn_dns_transfer(fd, (void *)q, (size_t)qlen, 1, deadline) == 0 &&
        bn_dns_transfer(fd, head, 2, 0, deadline) == 0) {
        int want = ((int)head[0] << 8) | head[1];
        if (want >= 12 && want <= rcap && bn_dns_transfer(fd, r, (size_t)want, 0, deadline) == 0)
            got = want;
    }
    int saved = errno;
    close(fd);
    errno = saved;
    return got;
}

static int bn_dns_query_one(const char *name, int qtype, bn_answer *out) {
    unsigned char q[512], r[4096];
    uint16_t id = bn_dns_id();
    int qlen = bn_dns_build(q, sizeof q, name, id, qtype);
    if (qlen < 0) return -1;

    out->v4_count = out->v6_count = 0;
    out->rcode = -1;

    for (int pass = 0; pass < bn_dns.attempts; pass++) {
        for (int i = 0; i < bn_dns.server_count; i++) {
            int got = bn_dns_udp(&bn_dns.server[i], q, qlen, r, sizeof r, bn_dns.timeout_ms);
            if (got < 0) continue;
            // Truncation means the answer is incomplete: retry over TCP.
            if (got < 12) continue;
            if (r[2] & 0x02) {
                got = bn_dns_tcp(&bn_dns.server[i], q, qlen, r, sizeof r, bn_dns.timeout_ms);
                if (got < 0) continue;
            }
            bn_answer parsed = {0};
            if (bn_dns_parse(r, got, id, qtype, &parsed) != 0) continue;
            *out = parsed;
            if (out->rcode != 0) {
                // A definite answer that the name does not exist: stop looking.
                if (out->rcode == 3) return 0;
                continue;
            }
            if (out->v4_count || out->v6_count) return 0;
            return 0;
        }
    }
    return -1;
}

// Apply the search list the way the resolver would: a name with at least
// ndots dots is tried as-is first, otherwise the search domains come first.
static int bn_dns_query(const char *name, int af, bn_answer *out) {
    int dots = 0;
    for (const char *p = name; *p; p++)
        if (*p == '.') dots++;

    char buf[512];
    size_t len = strlen(name);
    int absolute = len && name[len - 1] == '.';
    int as_is_first = absolute || dots >= bn_dns.ndots;
    int answered = 0;
    if (as_is_first) {
        if (bn_dns_query_one(name, af == AF_INET6 ? 28 : 1, out) == 0) {
            answered = 1;
            if (out->v4_count || out->v6_count || absolute) return 0;
        }
        if (absolute) return -1;
    }
    for (int i = 0; i < bn_dns.search_count; i++) {
        int n = snprintf(buf, sizeof buf, "%s.%s", name, bn_dns.search[i]);
        if (n < 0 || (size_t)n >= sizeof buf) continue;
        if (bn_dns_query_one(buf, af == AF_INET6 ? 28 : 1, out) == 0) {
            answered = 1;
            if (out->v4_count || out->v6_count) return 0;
        }
    }
    if (!as_is_first && bn_dns_query_one(name, af == AF_INET6 ? 28 : 1, out) == 0)
        return 0;
    return answered ? 0 : -1;
}

// ── the guest's own databases ──────────────────────────────────────
// Without this the guest would inherit the *host's* /etc/hosts, which is how
// `localhost` resolves even when the rootfs has no /etc/hosts at all.
static int bn_hosts_lookup(const char *name, int af, bn_answer *out) {
    char text[8192];
    if (bn_read_guest("/etc/hosts", text, sizeof text) <= 0) return -1;

    out->v4_count = out->v6_count = 0;
    out->rcode = 0;

    char *save = NULL;
    for (char *line = strtok_r(text, "\n", &save); line;
         line = strtok_r(NULL, "\n", &save)) {
        char *hash = strchr(line, '#');
        if (hash) *hash = '\0';
        char *fields[32];
        int nf = 0;
        char *s2 = NULL;
        for (char *f = strtok_r(line, " \t\r", &s2); f && nf < 32; f = strtok_r(NULL, " \t\r", &s2))
            fields[nf++] = f;
        if (nf < 2) continue;

        int match = 0;
        for (int i = 1; i < nf; i++)
            if (strcasecmp(fields[i], name) == 0) match = 1;
        if (!match) continue;

        struct in_addr v4;
        struct in6_addr v6;
        if (inet_pton(AF_INET, fields[0], &v4) == 1) {
            if (af != AF_INET6 && out->v4_count < BN_DNS_MAXV4)
                out->v4[out->v4_count++] = v4;
        } else if (inet_pton(AF_INET6, fields[0], &v6) == 1) {
            if (af != AF_INET && out->v6_count < BN_DNS_MAXV6)
                out->v6[out->v6_count++] = v6;
        }
    }
    return (out->v4_count || out->v6_count) ? 0 : -1;
}

// A name that is already an address needs no lookup, and must not be treated as
// one: passing it to the wire format would waste a round trip and then fail.
static int bn_numeric(const char *node, int af, char *out, size_t cap) {
    struct in_addr v4;
    struct in6_addr v6;
    if (af != AF_INET6 && inet_pton(AF_INET, node, &v4) == 1) {
        snprintf(out, cap, "%s", node);
        return 1;
    }
    if (af != AF_INET && inet_pton(AF_INET6, node, &v6) == 1) {
        snprintf(out, cap, "%s", node);
        return 1;
    }
    return 0;
}

// ── public entry points ────────────────────────────────────────────
typedef int (*gai_fn)(const char *, const char *, const struct addrinfo *, struct addrinfo **);

static gai_fn bn_real_getaddrinfo(void) {
    static _Thread_local gai_fn real;
    REAL(real, "getaddrinfo");
    return real;
}

// Resolve `node` to numeric addresses the guest can agree on. Returns the number
// of addresses appended to `nums`, or -1 when the guest has no usable resolver
// and libc's own behaviour should stand.
static int bn_resolve_to_numeric(const char *node, int af, char nums[][INET6_ADDRSTRLEN], int max) {
    if (!bn_dns_enabled()) return -1;
    bn_dns_refresh();

    bn_answer ans;
    int have_hosts = (bn_hosts_lookup(node, af, &ans) == 0);

    if (!have_hosts) {
        if (bn_dns.server_count == 0) {
            return -2;
        }
        if (af == AF_UNSPEC) {
            bn_answer v4 = {0}, v6 = {0};
            int r4 = bn_dns_query(node, AF_INET, &v4);
            int r6 = bn_dns_query(node, AF_INET6, &v6);
            if (r4 < 0 && r6 < 0) return -2;
            ans = v4;
            ans.v6_count = v6.v6_count;
            memcpy(ans.v6, v6.v6, sizeof ans.v6);
        } else if (bn_dns_query(node, af, &ans) != 0) return -2;
    }

    int n = 0;
    for (int i = 0; i < ans.v4_count && n < max; i++)
        if (inet_ntop(AF_INET, &ans.v4[i], nums[n], INET6_ADDRSTRLEN)) n++;
    for (int i = 0; i < ans.v6_count && n < max; i++)
        if (inet_ntop(AF_INET6, &ans.v6[i], nums[n], INET6_ADDRSTRLEN)) n++;
    return n;
}

int getaddrinfo(const char *node, const char *service, const struct addrinfo *hints,
                struct addrinfo **res) {
    gai_fn real = bn_real_getaddrinfo();
    if (res) *res = NULL;
    if (!real) { errno = ENOSYS; return EAI_SYSTEM; }
    if (!node || !*node || !bn_dns_enabled()) return real(node, service, hints, res);
    if (hints && (hints->ai_flags & AI_NUMERICHOST)) return real(node, service, hints, res);

    int af = hints ? hints->ai_family : AF_UNSPEC;
    char num[INET6_ADDRSTRLEN];
    if (bn_numeric(node, af, num, sizeof num)) return real(node, service, hints, res);

    struct addrinfo numeric_hints = {0};
    if (hints) numeric_hints = *hints;
    numeric_hints.ai_flags |= AI_NUMERICHOST;
    int numeric_rc = real(node, service, &numeric_hints, res);
    if (numeric_rc != EAI_NONAME) return numeric_rc;
    if (af != AF_UNSPEC && af != AF_INET && af != AF_INET6) return EAI_FAMILY;
    char nums[BN_DNS_MAXV4 + BN_DNS_MAXV6][INET6_ADDRSTRLEN];
    int n = bn_resolve_to_numeric(node, af, nums, BN_DNS_MAXV4 + BN_DNS_MAXV6);
    if (n == -1) return real(node, service, hints, res);
    if (n == -2) return EAI_AGAIN;
    if (n == 0) return EAI_NONAME;

    // Hand each address to libc as a numeric node so service names, socket
    // types, protocols and ordering keep their normal meaning.
    struct addrinfo *head = NULL, *tail = NULL;
    for (int i = 0; i < n; i++) {
        struct addrinfo *one = NULL;
        if (real(nums[i], service, hints, &one) != 0 || !one) continue;
        if (hints && (hints->ai_flags & AI_CANONNAME)) {
            for (struct addrinfo *p = one; p; p = p->ai_next) {
                if (p->ai_canonname) {
                    free(p->ai_canonname);
                    p->ai_canonname = strdup(node);
                }
            }
        }
        if (!head) head = one;
        else tail->ai_next = one;
        for (tail = one; tail->ai_next; tail = tail->ai_next) {}
    }
    if (!head) return real(node, service, hints, res);
    DBG("dns: %s -> %d address(es) from guest configuration\n", node, n);
    *res = head;
    return 0;
}

typedef struct hostent *(*ghbn_fn)(const char *);

static struct hostent *bn_gethost_by_name(const char *name, int af, ghbn_fn real) {
    if (!name || !*name || !real || !bn_dns_enabled()) return real ? real(name) : NULL;

    char num[INET6_ADDRSTRLEN];
    if (bn_numeric(name, af, num, sizeof num)) return real(name);

    char nums[BN_DNS_MAXV4 + BN_DNS_MAXV6][INET6_ADDRSTRLEN];
    int n = bn_resolve_to_numeric(name, af, nums, BN_DNS_MAXV4 + BN_DNS_MAXV6);
    if (n == -1) return real(name);
    if (n <= 0) { h_errno = n == -2 ? TRY_AGAIN : HOST_NOT_FOUND; return NULL; }
    return real(nums[0]);
}

struct hostent *gethostbyname(const char *name) {
    static _Thread_local ghbn_fn real;
    REAL(real, "gethostbyname");
    return bn_gethost_by_name(name, AF_INET, real);
}

struct hostent *gethostbyname2(const char *name, int af) {
    typedef struct hostent *(*fn_t)(const char *, int);
    static _Thread_local fn_t real;
    REAL(real, "gethostbyname2");
    if (!real) { h_errno = NO_RECOVERY; return NULL; }
    char nums[BN_DNS_MAXV4 + BN_DNS_MAXV6][INET6_ADDRSTRLEN];
    char num[INET6_ADDRSTRLEN];
    if (!name || !*name || !bn_dns_enabled() || bn_numeric(name, af, num, sizeof num))
        return real(name, af);
    int n = bn_resolve_to_numeric(name, af, nums, BN_DNS_MAXV4 + BN_DNS_MAXV6);
    if (n == -1) return real(name, af);
    if (n <= 0) { h_errno = n == -2 ? TRY_AGAIN : HOST_NOT_FOUND; return NULL; }
    return real(nums[0], af);
}

typedef int (*ghbn_r_fn)(const char *, struct hostent *, char *, size_t, struct hostent **, int *);

static int bn_gethost_by_name_r(ghbn_r_fn real, const char *name, struct hostent *ret, char *buf,
                                size_t buflen, struct hostent **result, int *h_errnop, int af) {
    if (!real) return ENOSYS;
    if (!name || !*name || !bn_dns_enabled()) return real(name, ret, buf, buflen, result, h_errnop);

    char num[INET6_ADDRSTRLEN];
    if (bn_numeric(name, af, num, sizeof num)) return real(name, ret, buf, buflen, result, h_errnop);

    char nums[BN_DNS_MAXV4 + BN_DNS_MAXV6][INET6_ADDRSTRLEN];
    int n = bn_resolve_to_numeric(name, af, nums, BN_DNS_MAXV4 + BN_DNS_MAXV6);
    if (n == -1) return real(name, ret, buf, buflen, result, h_errnop);
    if (n <= 0) {
        *result = NULL; *h_errnop = n == -2 ? TRY_AGAIN : HOST_NOT_FOUND;
        return n == -2 ? EAGAIN : 0;
    }
    return real(nums[0], ret, buf, buflen, result, h_errnop);
}

int gethostbyname_r(const char *name, struct hostent *ret, char *buf, size_t buflen,
                    struct hostent **result, int *h_errnop) {
    static _Thread_local ghbn_r_fn real;
    REAL(real, "gethostbyname_r");
    return bn_gethost_by_name_r(real, name, ret, buf, buflen, result, h_errnop, AF_INET);
}

int gethostbyname2_r(const char *name, int af, struct hostent *ret, char *buf, size_t buflen,
                     struct hostent **result, int *h_errnop) {
    typedef int (*fn_t)(const char *, int, struct hostent *, char *, size_t,
                        struct hostent **, int *);
    static _Thread_local fn_t real;
    REAL(real, "gethostbyname2_r");
    if (!real) { *result = NULL; *h_errnop = NO_RECOVERY; return ENOSYS; }
    char nums[BN_DNS_MAXV4 + BN_DNS_MAXV6][INET6_ADDRSTRLEN];
    char num[INET6_ADDRSTRLEN];
    if (!name || !*name || !bn_dns_enabled() || bn_numeric(name, af, num, sizeof num))
        return real(name, af, ret, buf, buflen, result, h_errnop);
    int n = bn_resolve_to_numeric(name, af, nums, BN_DNS_MAXV4 + BN_DNS_MAXV6);
    if (n == -1) return real(name, af, ret, buf, buflen, result, h_errnop);
    if (n <= 0) {
        *result = NULL; *h_errnop = n == -2 ? TRY_AGAIN : HOST_NOT_FOUND;
        return n == -2 ? EAGAIN : 0;
    }
    return real(nums[0], af, ret, buf, buflen, result, h_errnop);
}

// ── guest process + identity databases ─────────────────────────────
// Two more places where libc uses paths internally, so LD_PRELOAD cannot see
// them, and both are load-bearing for APT/dpkg:
//
//   * system()/popen() run the *host's* /bin/sh. On Android that is a bionic
//     shell, which inherits LD_PRELOAD and dies with
//     `CANNOT LINK EXECUTABLE "sh": library "libc.so.6" not found`, and even
//     when it survives it is the wrong shell with the wrong paths.
//   * the `files` NSS database reads the *host's* /etc/passwd and /etc/group,
//     so the guest cannot see its own users (`No sandbox user '_apt'`, and
//     chown/id/su in package maintainer scripts go wrong).

#include <grp.h>
#include <pwd.h>
#include <signal.h>
#include <sys/wait.h>

// Spawn directly, without allocating or resolving symbols in a post-fork child.
static int bn_spawn_shell(const char *cmd, const posix_spawn_file_actions_t *actions,
                           const posix_spawnattr_t *attr, pid_t *pid) {
    const char *launcher = bn_env("BIONILUX_BINARY_PATH");
    const char *rootfs = bn_rootfs();
    spawn_fn spawn = spawn_plain();
    if (!launcher || !rootfs || !spawn) return ENOSYS;
    const char *argv[] = {launcher, "--rootfs", rootfs, "/bin/sh", "-c", cmd, NULL};
    char **env = strip_ld_preload(environ);
    if (!env) return ENOMEM;
    int rc = spawn(pid, launcher, actions, attr, (char *const *)argv, env);
    free(env);
    return rc;
}

static int bn_wait_shell(pid_t pid, int *status) {
    int rc;
    do { rc = waitpid(pid, status, 0); } while (rc < 0 && errno == EINTR);
    return rc;
}

static pthread_mutex_t bn_system_lock = PTHREAD_MUTEX_INITIALIZER;
static unsigned bn_system_users;
static struct sigaction bn_old_int, bn_old_quit;

struct bn_system_cleanup {
    pid_t pid;
    sigset_t oldmask;
};

static void bn_system_restore(void *arg) {
    struct bn_system_cleanup *state = arg;
    int saved = errno, cancel_state;
    pthread_setcancelstate(PTHREAD_CANCEL_DISABLE, &cancel_state);
    if (state->pid > 0) {
        kill(state->pid, SIGKILL);
        int status;
        (void)bn_wait_shell(state->pid, &status);
    }
    pthread_sigmask(SIG_SETMASK, &state->oldmask, NULL);
    pthread_mutex_lock(&bn_system_lock);
    if (--bn_system_users == 0) {
        sigaction(SIGINT, &bn_old_int, NULL);
        sigaction(SIGQUIT, &bn_old_quit, NULL);
    }
    pthread_mutex_unlock(&bn_system_lock);
    errno = saved;
    pthread_setcancelstate(cancel_state, NULL);
}

int system(const char *cmd) {
    static _Thread_local int (*real)(const char *);
    REAL(real, "system");
    if (!bn_rootfs() || !bn_env("BIONILUX_BINARY_PATH"))
        return real ? real(cmd) : -1;
    if (!cmd) return access("/bin/sh", X_OK) == 0;

    struct sigaction ignore = {.sa_handler = SIG_IGN};
    sigemptyset(&ignore.sa_mask);
    pthread_mutex_lock(&bn_system_lock);
    if (bn_system_users++ == 0) {
        sigaction(SIGINT, &ignore, &bn_old_int);
        sigaction(SIGQUIT, &ignore, &bn_old_quit);
    }
    sigset_t defaults;
    sigemptyset(&defaults);
    if (bn_old_int.sa_handler != SIG_IGN) sigaddset(&defaults, SIGINT);
    if (bn_old_quit.sa_handler != SIG_IGN) sigaddset(&defaults, SIGQUIT);
    pthread_mutex_unlock(&bn_system_lock);

    sigset_t blocked;
    sigemptyset(&blocked);
    sigaddset(&blocked, SIGCHLD);
    struct bn_system_cleanup state = {.pid = -1};
    pthread_sigmask(SIG_BLOCK, &blocked, &state.oldmask);
    int status = -1, saved;
    pthread_cleanup_push(bn_system_restore, &state);
    posix_spawnattr_t attr;
    posix_spawnattr_init(&attr);
    posix_spawnattr_setsigmask(&attr, &state.oldmask);
    posix_spawnattr_setsigdefault(&attr, &defaults);
    posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF);
    pid_t pid;
    int rc = bn_spawn_shell(cmd, NULL, &attr, &pid);
    posix_spawnattr_destroy(&attr);
    if (rc == 0) {
        state.pid = pid;
        if (bn_wait_shell(pid, &status) < 0) status = -1;
        state.pid = -1;
    } else if (rc == EAGAIN || rc == ENOMEM) {
        errno = rc;
    } else {
        status = 127 << 8;
    }
    saved = errno;
    pthread_cleanup_pop(1);
    errno = saved;
    return status;
}

struct bn_popen {
    FILE *fp;
    pid_t pid;
    int writing;
    struct bn_popen *next;
};
static struct bn_popen *bn_popens;
static pthread_mutex_t bn_popen_lock = PTHREAD_MUTEX_INITIALIZER;

FILE *popen(const char *cmd, const char *mode) {
    static _Thread_local FILE *(*real)(const char *, const char *);
    REAL(real, "popen");
    if (!bn_rootfs() || !bn_env("BIONILUX_BINARY_PATH"))
        return real ? real(cmd, mode) : NULL;
    if (!mode || (mode[0] != 'r' && mode[0] != 'w') ||
        (mode[1] && (mode[1] != 'e' || mode[2]))) {
        errno = EINVAL; return NULL;
    }
    int for_read = mode[0] == 'r';
    struct bn_popen *entry = malloc(sizeof *entry);
    if (!entry) return NULL;
    int fds[2];
    if (pipe2(fds, O_CLOEXEC) != 0) { free(entry); return NULL; }
    int parent = fds[for_read ? 0 : 1];
    int child = fds[for_read ? 1 : 0];
    int dest = for_read ? STDOUT_FILENO : STDIN_FILENO;
    FILE *fp = fdopen(parent, for_read ? "r" : "w");
    if (!fp) {
        int saved = errno;
        close(fds[0]); close(fds[1]); free(entry);
        errno = saved; return NULL;
    }
    pthread_mutex_lock(&bn_popen_lock);
    posix_spawn_file_actions_t actions;
    int rc = posix_spawn_file_actions_init(&actions);
    if (rc == 0) {
        rc = posix_spawn_file_actions_adddup2(&actions, child, dest);
        for (int i = 0; i < 2 && !rc; i++)
            if (fds[i] != dest) rc = posix_spawn_file_actions_addclose(&actions, fds[i]);
        // POSIX requires closing streams from earlier popen calls in this child.
        for (struct bn_popen *p = bn_popens; p && !rc; p = p->next)
            if (fileno(p->fp) != dest)
                rc = posix_spawn_file_actions_addclose(&actions, fileno(p->fp));
        if (!rc) rc = bn_spawn_shell(cmd, &actions, NULL, &entry->pid);
        posix_spawn_file_actions_destroy(&actions);
    }
    close(child);
    if (rc == 0) {
        if (mode[1] != 'e') fcntl(parent, F_SETFD, 0);
        entry->fp = fp;
        entry->writing = !for_read;
        entry->next = bn_popens;
        bn_popens = entry;
    }
    pthread_mutex_unlock(&bn_popen_lock);
    if (rc) { fclose(fp); free(entry); errno = rc; return NULL; }
    return fp;
}

int pclose(FILE *fp) {
    static _Thread_local int (*real)(FILE *);
    REAL(real, "pclose");
    pthread_mutex_lock(&bn_popen_lock);
    struct bn_popen *entry = bn_popens;
    while (entry && entry->fp != fp) entry = entry->next;
    pthread_mutex_unlock(&bn_popen_lock);
    if (!entry) return real ? real(fp) : -1;

    // A write-stream flush may block. Keep it registered so concurrent popen
    // children close this writer, but do not hold the global lock while flushing.
    int flushed = entry->writing ? fflush(fp) : 0;
    int saved = errno;
    pthread_mutex_lock(&bn_popen_lock);
    struct bn_popen **link = &bn_popens;
    while (*link && *link != entry) link = &(*link)->next;
    int closed = fclose(fp);
    if (closed != 0) saved = errno;
    if (*link) *link = entry->next;
    pthread_mutex_unlock(&bn_popen_lock);

    int status;
    int rc = bn_wait_shell(entry->pid, &status);
    free(entry);
    if (rc < 0) return -1;
    if (flushed != 0 || closed != 0) { errno = saved; return -1; }
    return status;
}

// Parse the guest's password and group databases. The file formats are the
// usual colon-separated ones; a line that does not look right is skipped
// rather than aborting the lookup.
static int bn_field(char **fields, int count, int index, char **out) {
    if (index < 0 || index >= count) return -1;
    *out = fields[index];
    return 0;
}

static int bn_split(char *line, char **fields, int max) {
    int n = 0;
    char *p = line;
    if (max <= 0) return 0;
    fields[n++] = p;
    for (; *p; p++) {
        if (*p != ':' && *p != '\n') continue;
        int stop = (*p == '\n');
        *p = '\0';
        if (stop) break;
        if (n < max) fields[n++] = p + 1;
    }
    return n;
}

typedef int (*pw_get_fn)(const char *, struct passwd *, char *, size_t, struct passwd **);
typedef int (*pw_uid_fn)(uid_t, struct passwd *, char *, size_t, struct passwd **);
typedef int (*gr_get_fn)(const char *, struct group *, char *, size_t, struct group **);
typedef int (*gr_gid_fn)(gid_t, struct group *, char *, size_t, struct group **);

static int bn_passwd_fill(char **f, int nf, struct passwd *pw, char *buf, size_t buflen,
                          struct passwd **result) {
    char *name, *passwd, *uid, *gid, *gecos, *dir, *shell;
    if (nf < 7) return -1;
    if (bn_field(f, nf, 0, &name) || bn_field(f, nf, 1, &passwd) || bn_field(f, nf, 2, &uid) ||
        bn_field(f, nf, 3, &gid) || bn_field(f, nf, 4, &gecos) || bn_field(f, nf, 5, &dir) ||
        bn_field(f, nf, 6, &shell))
        return -1;

    size_t need = strlen(name) + strlen(passwd) + strlen(gecos) + strlen(dir) + strlen(shell) + 5;
    if (need > buflen) return -2;
    char *w = buf;
    pw->pw_name = w; w = stpcpy(w, name) + 1;
    pw->pw_passwd = w; w = stpcpy(w, passwd) + 1;
    pw->pw_uid = (uid_t)strtoul(uid, NULL, 10);
    pw->pw_gid = (gid_t)strtoul(gid, NULL, 10);
    pw->pw_gecos = w; w = stpcpy(w, gecos) + 1;
    pw->pw_dir = w; w = stpcpy(w, dir) + 1;
    pw->pw_shell = w; stpcpy(w, shell);
    *result = pw;
    return 0;
}

static int bn_passwd_lookup(const char *name, uid_t uid, int by_uid, struct passwd *pw, char *buf,
                            size_t buflen, struct passwd **result) {
    char text[16384];
    *result = NULL;
    if (bn_read_guest("/etc/passwd", text, sizeof text) <= 0) return -1;

    char *save = NULL;
    for (char *line = strtok_r(text, "\n", &save); line; line = strtok_r(NULL, "\n", &save)) {
        char *fields[8];
        char copy[1024];
        snprintf(copy, sizeof copy, "%s", line);
        int nf = bn_split(copy, fields, 8);
        if (nf < 7) continue;
        int match = by_uid ? ((uid_t)strtoul(fields[2], NULL, 10) == uid)
                           : (strcmp(fields[0], name) == 0);
        if (!match) continue;
        int rc = bn_passwd_fill(fields, nf, pw, buf, buflen, result);
        if (rc == -1) continue;
        if (rc == -2) return -2;   // ERANGE
        return 0;
    }
    return -1;   // not found
}

static int bn_group_lookup(const char *name, gid_t gid, int by_gid, struct group *gr, char *buf,
                           size_t buflen, struct group **result) {
    char text[16384];
    *result = NULL;
    if (bn_read_guest("/etc/group", text, sizeof text) <= 0) return -1;

    char *save = NULL;
    for (char *line = strtok_r(text, "\n", &save); line; line = strtok_r(NULL, "\n", &save)) {
        char *fields[6];
        char copy[512];
        snprintf(copy, sizeof copy, "%s", line);
        int nf = bn_split(copy, fields, 6);
        if (nf < 4) continue;
        int match = by_gid ? ((gid_t)strtoul(fields[2], NULL, 10) == gid)
                           : (strcmp(fields[0], name) == 0);
        if (!match) continue;

        size_t members = *fields[3] ? 1 : 0;
        for (const char *p = fields[3]; *p; p++)
            if (*p == ',') members++;
        size_t strings = strlen(fields[0]) + strlen(fields[1]) + strlen(fields[3]) + 3;
        size_t padding = (_Alignof(char *) - (uintptr_t)buf % _Alignof(char *)) % _Alignof(char *);
        size_t pointers = (members + 1) * sizeof(char *);
        if (padding > buflen || pointers > buflen - padding ||
            strings > buflen - padding - pointers) return -2;
        gr->gr_mem = (char **)(buf + padding);
        char *w = buf + padding + pointers;
        gr->gr_name = w; w = stpcpy(w, fields[0]) + 1;
        gr->gr_passwd = w; w = stpcpy(w, fields[1]) + 1;
        gr->gr_gid = (gid_t)strtoul(fields[2], NULL, 10);
        strcpy(w, fields[3]);
        size_t count = 0;
        char *save_member = NULL;
        for (char *p = strtok_r(w, ",", &save_member); p;
             p = strtok_r(NULL, ",", &save_member)) gr->gr_mem[count++] = p;
        gr->gr_mem[count] = NULL;
        *result = gr;
        return 0;
    }
    return -1;
}

static int (*bn_real_getpwnam_r(void))(const char *, struct passwd *, char *, size_t,
                                       struct passwd **) {
    static _Thread_local pw_get_fn r;
    REAL(r, "getpwnam_r");
    return r;
}
static int (*bn_real_getpwuid_r(void))(uid_t, struct passwd *, char *, size_t, struct passwd **) {
    static _Thread_local pw_uid_fn r;
    REAL(r, "getpwuid_r");
    return r;
}
static int (*bn_real_getgrnam_r(void))(const char *, struct group *, char *, size_t,
                                       struct group **) {
    static _Thread_local gr_get_fn r;
    REAL(r, "getgrnam_r");
    return r;
}
static int (*bn_real_getgrgid_r(void))(gid_t, struct group *, char *, size_t, struct group **) {
    static _Thread_local gr_gid_fn r;
    REAL(r, "getgrgid_r");
    return r;
}

// glibc marks these parameters nonnull, but the defensive checks below are
// still worth keeping for callers that reach us through PLT interposition.
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wnonnull-compare"

int getpwnam_r(const char *name, struct passwd *pw, char *buf, size_t buflen,
               struct passwd **result) {
    if (result) *result = NULL;
    if (!name || !(bn_rootfs() != NULL)) {
        pw_get_fn real = bn_real_getpwnam_r();
        return real ? real(name, pw, buf, buflen, result) : -1;
    }
    int rc = bn_passwd_lookup(name, 0, 0, pw, buf, buflen, result);
    if (rc == 0) return 0;
    if (rc == -2) return ERANGE;
    pw_get_fn real = bn_real_getpwnam_r();
    return real ? real(name, pw, buf, buflen, result) : -1;
}

int getpwuid_r(uid_t uid, struct passwd *pw, char *buf, size_t buflen, struct passwd **result) {
    if (result) *result = NULL;
    if (!(bn_rootfs() != NULL)) {
        pw_uid_fn real = bn_real_getpwuid_r();
        return real ? real(uid, pw, buf, buflen, result) : -1;
    }
    int rc = bn_passwd_lookup(NULL, uid, 1, pw, buf, buflen, result);
    if (rc == 0) return 0;
    if (rc == -2) return ERANGE;
    pw_uid_fn real = bn_real_getpwuid_r();
    return real ? real(uid, pw, buf, buflen, result) : -1;
}

int getgrnam_r(const char *name, struct group *gr, char *buf, size_t buflen,
               struct group **result) {
    if (result) *result = NULL;
    if (!name || !(bn_rootfs() != NULL)) {
        gr_get_fn real = bn_real_getgrnam_r();
        return real ? real(name, gr, buf, buflen, result) : -1;
    }
    int rc = bn_group_lookup(name, 0, 0, gr, buf, buflen, result);
    if (rc == 0) return 0;
    if (rc == -2) return ERANGE;
    gr_get_fn real = bn_real_getgrnam_r();
    return real ? real(name, gr, buf, buflen, result) : -1;
}

int getgrgid_r(gid_t gid, struct group *gr, char *buf, size_t buflen, struct group **result) {
    if (result) *result = NULL;
    if (!(bn_rootfs() != NULL)) {
        gr_gid_fn real = bn_real_getgrgid_r();
        return real ? real(gid, gr, buf, buflen, result) : -1;
    }
    int rc = bn_group_lookup(NULL, gid, 1, gr, buf, buflen, result);
    if (rc == 0) return 0;
    if (rc == -2) return ERANGE;
    gr_gid_fn real = bn_real_getgrgid_r();
    return real ? real(gid, gr, buf, buflen, result) : -1;
}

// The non-reentrant forms share one static buffer, exactly as libc does.
static struct passwd bn_pw_static;
static char bn_pw_buf[4096];
static struct group bn_gr_static;
static char bn_gr_buf[4096];

struct passwd *getpwnam(const char *name) {
    static _Thread_local struct passwd *(*real)(const char *);
    REAL(real, "getpwnam");
    if (!(bn_rootfs() != NULL)) return real ? real(name) : NULL;
    struct passwd *out = NULL;
    return getpwnam_r(name, &bn_pw_static, bn_pw_buf, sizeof bn_pw_buf, &out) == 0 ? out
                                                                                  : (real ? real(name) : NULL);
}

struct passwd *getpwuid(uid_t uid) {
    static _Thread_local struct passwd *(*real)(uid_t);
    REAL(real, "getpwuid");
    if (!(bn_rootfs() != NULL)) return real ? real(uid) : NULL;
    struct passwd *out = NULL;
    return getpwuid_r(uid, &bn_pw_static, bn_pw_buf, sizeof bn_pw_buf, &out) == 0 ? out
                                                                                  : (real ? real(uid) : NULL);
}

struct group *getgrnam(const char *name) {
    static _Thread_local struct group *(*real)(const char *);
    REAL(real, "getgrnam");
    if (!(bn_rootfs() != NULL)) return real ? real(name) : NULL;
    struct group *out = NULL;
    return getgrnam_r(name, &bn_gr_static, bn_gr_buf, sizeof bn_gr_buf, &out) == 0 ? out
                                                                                   : (real ? real(name) : NULL);
}

struct group *getgrgid(gid_t gid) {
    static _Thread_local struct group *(*real)(gid_t);
    REAL(real, "getgrgid");
    if (!(bn_rootfs() != NULL)) return real ? real(gid) : NULL;
    struct group *out = NULL;
    return getgrgid_r(gid, &bn_gr_static, bn_gr_buf, sizeof bn_gr_buf, &out) == 0 ? out
                                                                                  : (real ? real(gid) : NULL);
}

#pragma GCC diagnostic pop

#include "compat_syscall.inc.c"
#include "compat_python.inc.c"

__attribute__((constructor)) static void on_init(void) {
    for (size_t i = 0; i < sizeof bn_context / sizeof bn_context[0]; i++) {
        size_t len = strlen(bn_context[i].key);
        char name[64];
        memcpy(name, bn_context[i].key, len - 1); name[len - 1] = '\0';
        const char *value = getenv(name);
        if (!value) continue;
        size_t size = len + strlen(value) + 1;
        bn_context[i].entry = malloc(size);
        if (bn_context[i].entry) snprintf(bn_context[i].entry, size, "%s%s", bn_context[i].key, value);
    }
    (void)bionilux_debug();
    (void)bn_rootfs();
    (void)bn_fake_root();
    (void)bn_lenient();
    (void)bn_dns_enabled();
    (void)bn_under_host_paths("/");
    DBG("Injection successful! rootfs=%s\n",
        bn_rootfs() ? bn_rootfs() : "(none)");
}
