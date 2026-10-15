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
#include <net/if.h>
#include <netinet/in.h>
#include <spawn.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/time.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>
#include <utime.h>

extern char **environ;

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
static const char *bn_env(const char *name) {
    const char *v = getenv(name);
    return (v && *v) ? v : NULL;
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
static uid_t bn_vruid, bn_veuid, bn_vsuid;
static gid_t bn_vrgid, bn_vegid, bn_vsgid;

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
    static fn_t real;
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
    if (!bn_rootfs() || !bn_has_dotdot(path)) return path;

    char base[PATH_MAX];
    if (!bn_dir_base(dirfd, base, sizeof base)) return path;

    char logical_base[PATH_MAX];
    const char *logical = bn_unmap(base, logical_base, sizeof logical_base);
    if (logical == base) logical = "/";  // outside the guest: treat as the root

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

static char **strip_ld_preload(char *const envp[]) {
    size_t envc = 0;
    while (envp && envp[envc]) envc++;
    char **ev = malloc((envc + 1) * sizeof *ev);
    if (!ev) return NULL;
    size_t j = 0;
    for (size_t i = 0; i < envc; i++)
        if (strncmp(envp[i], "LD_PRELOAD=", 11) != 0) ev[j++] = envp[i];
    ev[j] = NULL;
    return ev;
}

// Resolve a bare command name against the *guest's* PATH.
//
// libc's execvp() and posix_spawnp() search the host's PATH, which holds
// Android's binaries: a guest name such as "awk" would either not be found at
// all or would run the host's program. GNU make execs recipe commands this
// way, so a kernel build fails as `make: awk: No such file or directory`.
// Fills `out` with a guest absolute path and returns 1 on success.
static int bn_which(const char *name, char *out, size_t size) {
    if (!name || !*name) return 0;

    const char *path = getenv("PATH");
    if (!path || !*path) path = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

    for (const char *p = path; *p; ) {
        const char *end = strchr(p, ':');
        size_t len = end ? (size_t)(end - p) : strlen(p);

        // An empty component means the current directory.
        char cand[PATH_MAX];
        int n = len ? snprintf(cand, sizeof cand, "%.*s/", (int)len, p)
                    : snprintf(cand, sizeof cand, "%s", "");
        if (n > 0 && (size_t)n < sizeof cand) {
            int m = snprintf(out, size, "%s%s", cand, name);
            if (m > 0 && (size_t)m < size) {
                char mapped[PATH_MAX];
                const char *probe = bn_resolve(AT_FDCWD, out, mapped, sizeof mapped);
                if (access(probe, X_OK) == 0) return 1;
            }
        }
        if (!end) break;
        p = end + 1;
    }
    return 0;
}

// Build [launcher, target, argv[1..]] with a stripped envp.
// Returns 1 when the call was rerouted, 0 when it should be handed to the
// kernel untouched, and -1 when `target` cannot be resolved at all — a bare
// name that is not in the guest's PATH must not fall through to libc, which
// would then search the host's.
static int reroute(const char *target, char *const argv[], char *const envp[],
                   const char **launcher, char ***nargv, char ***nenvp) {
    *launcher = getenv("BIONILUX_BINARY_PATH");
    if (!*launcher || !target || is_launcher(target, *launcher)) return 0;

    char resolved[PATH_MAX];
    if (!strchr(target, '/')) {
        if (!bn_which(target, resolved, sizeof resolved)) { errno = ENOENT; return -1; }
        target = resolved;
    }

    // A path that cannot be executed is handed to the kernel, which reports
    // the real reason (EACCES, ENOTDIR, ENOENT) instead of a generic 127.
    // The probe must use the mapped path: an absolute guest path does not
    // exist on the host.
    if (strchr(target, '/')) {
        char buf[PATH_MAX];
        const char *probe = bn_resolve(AT_FDCWD, target, buf, sizeof buf);
        if (access(probe, X_OK) != 0) return 0;
    }

    size_t argc = 0;
    while (argv && argv[argc]) argc++;
    size_t n = argc ? argc : 1;

    char **av = malloc((n + 2) * sizeof *av);
    char **ev = strip_ld_preload(envp);
    if (!av || !ev) { free(av); free(ev); return 0; }

    av[0] = (char *)*launcher;
    av[1] = (char *)target;
    for (size_t i = 1; i < argc; i++) av[i + 1] = argv[i];
    av[n + 1] = NULL;

    *nargv = av;
    *nenvp = ev;
    DBG("Routing through bionilux: %s\n", target);
    return 1;
}

static int real_execve(const char *p, char *const a[], char *const e[]) {
    typedef int (*fn_t)(const char *, char *const[], char *const[]);
    static fn_t fn;
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
    int r = real_execve(path, argv, clean ? clean : envp);
    int e = errno;
    free(clean);
    errno = e;
    return r;
}

// ── exec* family ───────────────────────────────────────────────────
int execve(const char *path, char *const argv[], char *const envp[]) {
    if (is_launcher(path, getenv("BIONILUX_BINARY_PATH")))
        return exec_launcher(path, argv, envp);
    const char *l; char **av, **ev;
    int r = reroute(path, argv, envp, &l, &av, &ev);
    if (r < 0) return -1;
    if (r) return run_rerouted(l, av, ev);
    return real_execve(path, argv, envp);
}

int execv(const char *path, char *const argv[]) {
    return execve(path, argv, environ);
}

int execvp(const char *file, char *const argv[]) {
    typedef int (*fn_t)(const char *, char *const[]);
    static fn_t real;
    REAL(real, "execvp");
    if (is_launcher(file, getenv("BIONILUX_BINARY_PATH")))
        return exec_launcher(file, argv, environ);
    const char *l; char **av, **ev;
    int r = reroute(file, argv, environ, &l, &av, &ev);
    if (r < 0) return -1;
    if (r) return run_rerouted(l, av, ev);
    return real(file, argv);
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
    static fn_t real; REAL(real, "readlinkat");
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
    static fn_t real;
    REAL(real, "fexecve");
    if (getenv("BIONILUX_BINARY_PATH")) {
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
    static fn_t real;
    REAL(real, "execveat");
    if (getenv("BIONILUX_BINARY_PATH")) {
        if ((flags & AT_EMPTY_PATH) && path[0] == '\0') {
            char fd_path[PATH_MAX];
            if (resolve_fd_path(dirfd, fd_path, sizeof fd_path) > 0)
                return execve(fd_path, argv, envp);
        } else if (path[0] == '/' || dirfd == AT_FDCWD) {
            return execve(path, argv, envp);
        } else {
            // Relative to a directory fd. Upstream let this reach the kernel,
            // which resolved it against host paths; joining the fd's real path
            // keeps the child inside the guest.
            char dir[PATH_MAX];
            char joined[PATH_MAX];
            if (resolve_fd_path(dirfd, dir, sizeof dir) > 0) {
                int n = snprintf(joined, sizeof joined, "%s/%s", dir, path);
                if (n > 0 && (size_t)n < sizeof joined) {
                    char resolved[PATH_MAX];
                    if (realpath(joined, resolved)) {
                        char probe[PATH_MAX];
                        // Only accept the result if it is already physical:
                        // anything else would escape the guest.
                        if ((bn_rootfs() == NULL || bn_map(resolved, probe, sizeof probe) == resolved))
                            return execve(resolved, argv, envp);
                    }
                }
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
    static spawn_fn fn;
    REAL(fn, "posix_spawn");
    return fn;
}

static int spawn_impl(int search_path, pid_t *pid, const char *path,
                      const posix_spawn_file_actions_t *fa, const posix_spawnattr_t *attr,
                      char *const argv[], char *const envp[]) {
    spawn_fn plain = spawn_plain();
    if (!plain) { errno = ENOSYS; return -1; }

    if (is_launcher(path, getenv("BIONILUX_BINARY_PATH"))) {
        char **clean = strip_ld_preload(envp);
        int r = plain(pid, path, fa, attr, argv, clean ? clean : envp);
        int e = errno; free(clean); errno = e;
        return r;
    }

    const char *l; char **av, **ev;
    int re = reroute(path, argv, envp, &l, &av, &ev);
    if (re < 0) return -1;
    if (re) {
        int r = plain(pid, l, fa, attr, av, ev);
        int e = errno; free(av); free(ev); errno = e;
        return r;
    }

    if (search_path) {
        typedef int (*fn_t)(pid_t *, const char *, const posix_spawn_file_actions_t *,
                            const posix_spawnattr_t *, char *const[], char *const[]);
        static fn_t real;
        REAL(real, "posix_spawnp");
        if (real) return real(pid, path, fa, attr, argv, envp);
        errno = ENOSYS; return -1;
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
    static open_fn real; REAL(real, "open");
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
    static open_fn real; REAL(real, "open64");
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
    static open_fn real; REAL(real, "__open_2");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), flags);
}

int __open64_2(const char *path, int flags) {
    static open_fn real; REAL(real, "__open64_2");
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
    static fn_t real; REAL(real, "dlopen");
    if (!real) { errno = ENOSYS; return NULL; }
    if (!filename || !*filename || !bn_rootfs()) return real(filename, flags);
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, filename, buf, sizeof buf), flags);
}

int creat64(const char *path, mode_t mode) {
    return open64(path, O_CREAT | O_WRONLY | O_TRUNC, mode);
}

int openat(int dirfd, const char *path, int flags, ...) {
    static openat_fn real; REAL(real, "openat");
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
    static openat_fn real; REAL(real, "openat64");
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
    static openat_fn real; REAL(real, "__openat_2");
    char buf[PATH_MAX];
    const char *t = bn_resolve(dirfd, path, buf, sizeof buf);
    return real(dirfd, t, flags);
}

int __openat64_2(int dirfd, const char *path, int flags) {
    static openat_fn real; REAL(real, "__openat64_2");
    char buf[PATH_MAX];
    const char *t = bn_resolve(dirfd, path, buf, sizeof buf);
    return real(dirfd, t, flags);
}

// stdio entry points. Applications call these directly; glibc's own internal
// callers cannot be intercepted, so both layers matter.
FILE *fopen(const char *path, const char *mode) {
    typedef FILE *(*fn_t)(const char *, const char *);
    static fn_t real; REAL(real, "fopen");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), mode);
}

FILE *fopen64(const char *path, const char *mode) {
    typedef FILE *(*fn_t)(const char *, const char *);
    static fn_t real; REAL(real, "fopen64");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), mode);
}

FILE *freopen(const char *path, const char *mode, FILE *stream) {
    typedef FILE *(*fn_t)(const char *, const char *, FILE *);
    static fn_t real; REAL(real, "freopen");
    if (!path) return real(NULL, mode, stream);
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), mode, stream);
}

DIR *opendir(const char *path) {
    typedef DIR *(*fn_t)(const char *);
    static fn_t real; REAL(real, "opendir");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf));
}

// ── stat / access ──────────────────────────────────────────────────
int stat(const char *path, struct stat *st) {
    typedef int (*fn_t)(const char *, struct stat *);
    static fn_t real; REAL(real, "stat");
    char buf[PATH_MAX];
    int rc = real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), st);
    if (rc == 0) BN_VIRT_STAT(*st);
    return rc;
}

int lstat(const char *path, struct stat *st) {
    typedef int (*fn_t)(const char *, struct stat *);
    static fn_t real; REAL(real, "lstat");
    char buf[PATH_MAX];
    int rc = real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), st);
    if (rc == 0) BN_VIRT_STAT(*st);
    return rc;
}

int stat64(const char *path, struct stat64 *st) {
    typedef int (*fn_t)(const char *, struct stat64 *);
    static fn_t real; REAL(real, "stat64");
    char buf[PATH_MAX];
    int rc = real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), st);
    if (rc == 0) BN_VIRT_STAT(*st);
    return rc;
}

int lstat64(const char *path, struct stat64 *st) {
    typedef int (*fn_t)(const char *, struct stat64 *);
    static fn_t real; REAL(real, "lstat64");
    char buf[PATH_MAX];
    int rc = real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), st);
    if (rc == 0) BN_VIRT_STAT(*st);
    return rc;
}

int fstatat(int dirfd, const char *path, struct stat *st, int flags) {
    typedef int (*fn_t)(int, const char *, struct stat *, int);
    static fn_t real; REAL(real, "fstatat");
    char buf[PATH_MAX];
    const char *t = bn_resolve(dirfd, path, buf, sizeof buf);
    int rc = real(dirfd, t, st, flags);
    if (rc == 0) BN_VIRT_STAT(*st);
    return rc;
}

int fstatat64(int dirfd, const char *path, struct stat64 *st, int flags) {
    typedef int (*fn_t)(int, const char *, struct stat64 *, int);
    static fn_t real; REAL(real, "fstatat64");
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
    static fn_t real; REAL(real, "fstat");
    int rc = real(fd, st);
    if (rc == 0) BN_VIRT_STAT(*st);
    return rc;
}

int fstat64(int fd, struct stat64 *st) {
    typedef int (*fn_t)(int, struct stat64 *);
    static fn_t real; REAL(real, "fstat64");
    int rc = real(fd, st);
    if (rc == 0) BN_VIRT_STAT(*st);
    return rc;
}

int access(const char *path, int mode) {
    typedef int (*fn_t)(const char *, int);
    static fn_t real; REAL(real, "access");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), mode);
}

// glibc's stat()/lstat() wrappers are implemented with the statx syscall on
// current kernels, and coreutils calls statx directly when it is available.
int statx(int dirfd, const char *path, int flags, unsigned int mask,
          struct statx *st) {
    typedef int (*fn_t)(int, const char *, int, unsigned int, struct statx *);
    static fn_t real;
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
    static fn_t real; REAL(real, "faccessat");
    char buf[PATH_MAX];
    const char *t = bn_resolve(dirfd, path, buf, sizeof buf);
    return real(dirfd, t, mode, flags);
}

int statvfs(const char *path, struct statvfs *st) {
    typedef int (*fn_t)(const char *, struct statvfs *);
    static fn_t real; REAL(real, "statvfs");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), st);
}

int statvfs64(const char *path, struct statvfs64 *st) {
    typedef int (*fn_t)(const char *, struct statvfs64 *);
    static fn_t real; REAL(real, "statvfs64");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), st);
}

// ── directory and file operations ──────────────────────────────────
int chdir(const char *path) {
    typedef int (*fn_t)(const char *);
    static fn_t real; REAL(real, "chdir");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf));
}

char *getcwd(char *buf, size_t size) {
    typedef char *(*fn_t)(char *, size_t);
    static fn_t real; REAL(real, "getcwd");
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
    (void)buflen;
    return getcwd(buf, size);
}

int chmod(const char *path, mode_t mode) {
    typedef int (*fn_t)(const char *, mode_t);
    static fn_t real; REAL(real, "chmod");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), mode);
}

// coreutils' chmod prefers fchmodat, so this entry point is the one that
// actually matters for dpkg and package maintainer scripts.
int fchmodat(int dirfd, const char *path, mode_t mode, int flags) {
    typedef int (*fn_t)(int, const char *, mode_t, int);
    static fn_t real; REAL(real, "fchmodat");
    char buf[PATH_MAX];
    return real(dirfd, bn_resolve(dirfd, path, buf, sizeof buf), mode, flags);
}

int fchmodat2(int dirfd, const char *path, mode_t mode, int flags) {
    typedef int (*fn_t)(int, const char *, mode_t, int);
    static fn_t real; REAL(real, "fchmodat2");
    if (!real) { errno = ENOSYS; return -1; }
    char buf[PATH_MAX];
    return real(dirfd, bn_resolve(dirfd, path, buf, sizeof buf), mode, flags);
}

int truncate(const char *path, off_t length) {
    typedef int (*fn_t)(const char *, off_t);
    static fn_t real; REAL(real, "truncate");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), length);
}

int truncate64(const char *path, off64_t length) {
    typedef int (*fn_t)(const char *, off64_t);
    static fn_t real; REAL(real, "truncate64");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), length);
}

int mknod(const char *path, mode_t mode, dev_t dev) {
    typedef int (*fn_t)(const char *, mode_t, dev_t);
    static fn_t real; REAL(real, "mknod");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), mode, dev);
}

int mknodat(int dirfd, const char *path, mode_t mode, dev_t dev) {
    typedef int (*fn_t)(int, const char *, mode_t, dev_t);
    static fn_t real; REAL(real, "mknodat");
    char buf[PATH_MAX];
    return real(dirfd, bn_resolve(dirfd, path, buf, sizeof buf), mode, dev);
}

int mkdir(const char *path, mode_t mode) {
    typedef int (*fn_t)(const char *, mode_t);
    static fn_t real; REAL(real, "mkdir");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), mode);
}

int mkdirat(int dirfd, const char *path, mode_t mode) {
    typedef int (*fn_t)(int, const char *, mode_t);
    static fn_t real; REAL(real, "mkdirat");
    char buf[PATH_MAX];
    const char *t = bn_resolve(dirfd, path, buf, sizeof buf);
    return real(dirfd, t, mode);
}

int rmdir(const char *path) {
    typedef int (*fn_t)(const char *);
    static fn_t real; REAL(real, "rmdir");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf));
}

int unlink(const char *path) {
    typedef int (*fn_t)(const char *);
    static fn_t real; REAL(real, "unlink");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf));
}

int unlinkat(int dirfd, const char *path, int flags) {
    typedef int (*fn_t)(int, const char *, int);
    static fn_t real; REAL(real, "unlinkat");
    char buf[PATH_MAX];
    const char *t = bn_resolve(dirfd, path, buf, sizeof buf);
    return real(dirfd, t, flags);
}

int rename(const char *from, const char *to) {
    typedef int (*fn_t)(const char *, const char *);
    static fn_t real; REAL(real, "rename");
    char b1[PATH_MAX], b2[PATH_MAX];
    const char *f = bn_resolve(AT_FDCWD, from, b1, sizeof b1);
    const char *t = bn_resolve(AT_FDCWD, to, b2, sizeof b2);
    return real(f, t);
}

int renameat(int olddirfd, const char *oldpath, int newdirfd, const char *newpath) {
    typedef int (*fn_t)(int, const char *, int, const char *);
    static fn_t real; REAL(real, "renameat");
    char b1[PATH_MAX], b2[PATH_MAX];
    const char *f = bn_resolve(olddirfd, oldpath, b1, sizeof b1);
    const char *t = bn_resolve(newdirfd, newpath, b2, sizeof b2);
    return real(olddirfd, f, newdirfd, t);
}

int renameat2(int olddirfd, const char *oldpath, int newdirfd, const char *newpath,
              unsigned int flags) {
    typedef int (*fn_t)(int, const char *, int, const char *, unsigned int);
    static fn_t real; REAL(real, "renameat2");
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
static int bn_copy_file(const char *from, const char *to, mode_t mode) {
    typedef int (*open_fn)(const char *, int, ...);
    typedef ssize_t (*read_fn)(int, void *, size_t);
    typedef ssize_t (*write_fn)(int, const void *, size_t);
    typedef int (*close_fn)(int);
    static open_fn ro; static read_fn rr; static write_fn rw; static close_fn rc_;
    REAL(ro, "open"); REAL(rr, "read"); REAL(rw, "write"); REAL(rc_, "close");
    if (!ro || !rr || !rw || !rc_) { errno = ENOSYS; return -1; }

    int in = ro(from, O_RDONLY);
    if (in < 0) return -1;
    int out = ro(to, O_WRONLY | O_CREAT | O_EXCL, mode & 07777);
    if (out < 0) { int e = errno; rc_(in); errno = e; return -1; }

    char buf[65536];
    int rc = 0;
    for (;;) {
        ssize_t got = rr(in, buf, sizeof buf);
        if (got < 0) { rc = -1; break; }
        if (got == 0) break;
        ssize_t done = 0;
        while (done < got) {
            ssize_t put = rw(out, buf + done, (size_t)(got - done));
            if (put <= 0) { rc = -1; break; }
            done += put;
        }
        if (rc < 0) break;
    }
    int e = errno;
    rc_(in);
    rc_(out);
    errno = e;
    return rc;
}

// The hard link the platform refused, expressed as a copy. `rc` and `e` are the
// original failure so it can still be reported when no copy is possible.
static int bn_link_or_copy(const char *from, const char *to, int rc, int e) {
    if (rc == 0) return 0;
    if (e != EPERM && e != EACCES && e != EOPNOTSUPP && e != EXDEV) {
        errno = e;
        return rc;
    }

    typedef int (*stat_fn)(const char *, struct stat *);
    static stat_fn rs;
    REAL(rs, "stat");
    struct stat st;
    if (rs && rs(from, &st) == 0 && S_ISREG(st.st_mode)) {
        if (bn_copy_file(from, to, st.st_mode) == 0) {
            DBG("link: kernel refused (%s), copied instead: %s -> %s\n", strerror(e), from, to);
            return 0;
        }
    }
    errno = e;
    return rc;
}

int link(const char *from, const char *to) {
    typedef int (*fn_t)(const char *, const char *);
    static fn_t real; REAL(real, "link");
    char b1[PATH_MAX], b2[PATH_MAX];
    const char *f = bn_resolve(AT_FDCWD, from, b1, sizeof b1);
    const char *t = bn_resolve(AT_FDCWD, to, b2, sizeof b2);
    int rc = real(f, t);
    if (rc == 0 || !bn_rootfs()) return rc;
    return bn_link_or_copy(f, t, rc, errno);
}

// An absolute symlink target is stored as its physical path, and readlink()
// maps it back, so the guest always sees the logical target it asked for.
// Storing it verbatim would let a link such as /usr/lib/os-release ->
// /etc/os-release escape the guest at open() time.
static const char *bn_map_symlink_target(const char *target, char *buf, size_t size) {
    if (!target || target[0] != '/') return target;
    if (!bn_rootfs()) return target;
    if (bn_under(target, bn_rootfs())) return target;
    return bn_map(target, buf, size);
}

int symlink(const char *target, const char *linkpath) {
    typedef int (*fn_t)(const char *, const char *);
    static fn_t real; REAL(real, "symlink");
    char tbuf[PATH_MAX], lbuf[PATH_MAX];
    const char *tg = bn_map_symlink_target(target, tbuf, sizeof tbuf);
    const char *lp = bn_resolve(AT_FDCWD, linkpath, lbuf, sizeof lbuf);
    return real(tg, lp);
}

int symlinkat(const char *target, int dirfd, const char *linkpath) {
    typedef int (*fn_t)(const char *, int, const char *);
    static fn_t real; REAL(real, "symlinkat");
    char tbuf[PATH_MAX], lbuf[PATH_MAX];
    const char *tg = bn_map_symlink_target(target, tbuf, sizeof tbuf);
    const char *lp = bn_resolve(dirfd, linkpath, lbuf, sizeof lbuf);
    return real(tg, dirfd, lp);
}

int linkat(int ofd, const char *from, int nfd, const char *to, int flags) {
    typedef int (*fn_t)(int, const char *, int, const char *, int);
    static fn_t real; REAL(real, "linkat");
    char b1[PATH_MAX], b2[PATH_MAX];
    const char *f = bn_resolve(ofd, from, b1, sizeof b1);
    const char *t = bn_resolve(nfd, to, b2, sizeof b2);
    int rc = real(ofd, f, nfd, t, flags);
    if (rc == 0 || !bn_rootfs()) return rc;
    return bn_link_or_copy(f, t, rc, errno);
}

int utimensat(int dirfd, const char *path, const struct timespec times[2], int flags) {
    typedef int (*fn_t)(int, const char *, const struct timespec[2], int);
    static fn_t real; REAL(real, "utimensat");
    if (!real) { errno = ENOSYS; return -1; }
    char buf[PATH_MAX];
    const char *t = bn_resolve(dirfd, path, buf, sizeof buf);
    return real(dirfd, t, times, flags);
}

int utimes(const char *path, const struct timeval times[2]) {
    typedef int (*fn_t)(const char *, const struct timeval[2]);
    static fn_t real; REAL(real, "utimes");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), times);
}

int utime(const char *path, const struct utimbuf *times) {
    typedef int (*fn_t)(const char *, const struct utimbuf *);
    static fn_t real; REAL(real, "utime");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), times);
}

// ── readlink / realpath ────────────────────────────────────────────
static ssize_t fake_exe(char *buf, size_t size) {
    const char *exe = getenv("BIONILUX_TARGET_EXE");
    if (!exe) return -1;
    size_t len = strlen(exe);
    size_t n = len < size ? len : size;
    memcpy(buf, exe, n);
    return (ssize_t)n;
}

ssize_t readlinkat(int dirfd, const char *path, char *buf, size_t size) {
    typedef ssize_t (*fn_t)(int, const char *, char *, size_t);
    static fn_t real; REAL(real, "readlinkat");
    if (path && strcmp(path, "/proc/self/exe") == 0) {
        ssize_t r = fake_exe(buf, size);
        if (r >= 0) return r;
    }
    char mapped[PATH_MAX];
    const char *t = bn_resolve(dirfd, path, mapped, sizeof mapped);
    ssize_t r = real(dirfd, t, buf, size);
    if (r <= 0) return r;

    // The guest must see its own view of the path, not the physical one.
    char raw[PATH_MAX];
    size_t n = (size_t)r < sizeof raw - 1 ? (size_t)r : sizeof raw - 1;
    memcpy(raw, buf, n);
    raw[n] = '\0';
    char logical[PATH_MAX];
    const char *u = bn_unmap(raw, logical, sizeof logical);
    if (u == raw) return r;
    size_t len = strlen(logical);
    size_t copy = len < size ? len : size;
    memcpy(buf, logical, copy);
    return (ssize_t)copy;
}

ssize_t readlink(const char *path, char *buf, size_t size) {
    return readlinkat(AT_FDCWD, path, buf, size);
}

ssize_t __readlink_chk(const char *path, char *buf, size_t size, size_t buflen) {
    (void)buflen;
    return readlink(path, buf, size);
}

ssize_t __readlinkat_chk(int dirfd, const char *path, char *buf, size_t size, size_t buflen) {
    (void)buflen;
    return readlinkat(dirfd, path, buf, size);
}

char *realpath(const char *path, char *resolved) {
    typedef char *(*fn_t)(const char *, char *);
    static fn_t real; REAL(real, "realpath");
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

// _FORTIFY_SOURCE rewrites realpath(path, buf) into __realpath_chk. Debian and
// Ubuntu enable fortification by default, so this entry point matters as much
// as realpath itself.
char *__realpath_chk(const char *path, char *resolved, size_t resolvedlen) {
    (void)resolvedlen;
    return realpath(path, resolved);
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
    static fn_t real; REAL(real, "getuid");
    return bn_fake_root() ? bn_vruid : real();
}

uid_t geteuid(void) {
    typedef uid_t (*fn_t)(void);
    static fn_t real; REAL(real, "geteuid");
    return bn_fake_root() ? bn_veuid : real();
}

gid_t getgid(void) {
    typedef gid_t (*fn_t)(void);
    static fn_t real; REAL(real, "getgid");
    return bn_fake_root() ? bn_vrgid : real();
}

gid_t getegid(void) {
    typedef gid_t (*fn_t)(void);
    static fn_t real; REAL(real, "getegid");
    return bn_fake_root() ? bn_vegid : real();
}

int getresuid(uid_t *r, uid_t *e, uid_t *s) {
    if (!bn_fake_root()) {
        typedef int (*fn_t)(uid_t *, uid_t *, uid_t *);
        static fn_t real; REAL(real, "getresuid");
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
        static fn_t real; REAL(real, "getresgid");
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
    static fn_t real; REAL(real, "chown");
    char buf[PATH_MAX];
    const char *t = bn_resolve(AT_FDCWD, path, buf, sizeof buf);
    if (bn_fake_root()) { (void)uid; (void)gid; return 0; }
    return real(t, uid, gid);
}

int lchown(const char *path, uid_t uid, gid_t gid) {
    typedef int (*fn_t)(const char *, uid_t, gid_t);
    static fn_t real; REAL(real, "lchown");
    char buf[PATH_MAX];
    const char *t = bn_resolve(AT_FDCWD, path, buf, sizeof buf);
    if (bn_fake_root()) { (void)uid; (void)gid; return 0; }
    return real(t, uid, gid);
}

int fchown(int fd, uid_t uid, gid_t gid) {
    typedef int (*fn_t)(int, uid_t, gid_t);
    static fn_t real; REAL(real, "fchown");
    if (bn_fake_root()) { (void)uid; (void)gid; return 0; }
    return real(fd, uid, gid);
}

int fchownat(int dirfd, const char *path, uid_t uid, gid_t gid, int flags) {
    typedef int (*fn_t)(int, const char *, uid_t, gid_t, int);
    static fn_t real; REAL(real, "fchownat");
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
static const char BN_TMP_CHARS[] =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

static unsigned bn_rand_state;

static unsigned bn_rand(void) {
    if (!bn_rand_state) {
        struct timespec ts;
        clock_gettime(CLOCK_REALTIME, &ts);
        bn_rand_state = (unsigned)ts.tv_nsec ^ (unsigned)getpid() ^ (unsigned)ts.tv_sec;
        if (!bn_rand_state) bn_rand_state = 0x9e3779b9u;
    }
    // xorshift32
    bn_rand_state ^= bn_rand_state << 13;
    bn_rand_state ^= bn_rand_state >> 17;
    bn_rand_state ^= bn_rand_state << 5;
    return bn_rand_state;
}

static int bn_mkstemp_at(char *tmpl, int extra_flags, int suffixlen) {
    size_t len = strlen(tmpl);
    if (len < 6 || (int)len < suffixlen + 6) { errno = EINVAL; return -1; }
    char *xx = tmpl + len - (size_t)suffixlen - 6;
    if (strncmp(xx, "XXXXXX", 6) != 0) { errno = EINVAL; return -1; }

    for (int attempt = 0; attempt < 128; attempt++) {
        for (int i = 0; i < 6; i++)
            xx[i] = BN_TMP_CHARS[bn_rand() % (sizeof BN_TMP_CHARS - 1)];

        char mapped[PATH_MAX];
        const char *target = bn_resolve(AT_FDCWD, tmpl, mapped, sizeof mapped);
        int fd = open(target, extra_flags | O_CREAT | O_EXCL | O_RDWR, 0600);
        if (fd >= 0) return fd;
        if (errno != EEXIST) return -1;
    }
    errno = EEXIST;
    return -1;
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
    static fn_t real; REAL(real, "lutimes");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), times);
}

int mkfifo(const char *path, mode_t mode) {
    typedef int (*fn_t)(const char *, mode_t);
    static fn_t real; REAL(real, "mkfifo");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), mode);
}

int mkfifoat(int dirfd, const char *path, mode_t mode) {
    typedef int (*fn_t)(int, const char *, mode_t);
    static fn_t real; REAL(real, "mkfifoat");
    char buf[PATH_MAX];
    return real(dirfd, bn_resolve(dirfd, path, buf, sizeof buf), mode);
}

// glibc's mkdtemp creates the directory with an internal mkdir(), which our
// hook cannot see, so an absolute template would create it on the host. Create
// it here instead, through the mapped path, and keep the caller's template
// logical so later calls on it map the same way.
char *mkdtemp(char *tmpl) {
    size_t len = strlen(tmpl);
    if (len < 6 || strncmp(tmpl + len - 6, "XXXXXX", 6) != 0) {
        errno = EINVAL;
        return NULL;
    }
    char *xx = tmpl + len - 6;
    for (int attempt = 0; attempt < 128; attempt++) {
        for (int i = 0; i < 6; i++)
            xx[i] = BN_TMP_CHARS[bn_rand() % (sizeof BN_TMP_CHARS - 1)];

        char mapped[PATH_MAX];
        const char *target = bn_resolve(AT_FDCWD, tmpl, mapped, sizeof mapped);
        if (mkdir(target, 0700) == 0) return tmpl;
        if (errno != EEXIST) return NULL;
    }
    errno = EEXIST;
    return NULL;
}

int scandir(const char *path, struct dirent ***namelist,
            int (*filter)(const struct dirent *),
            int (*compar)(const struct dirent **, const struct dirent **)) {
    typedef int (*fn_t)(const char *, struct dirent ***, int (*)(const struct dirent *),
                        int (*)(const struct dirent **, const struct dirent **));
    static fn_t real; REAL(real, "scandir");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), namelist, filter, compar);
}

int statfs(const char *path, struct statfs *st) {
    typedef int (*fn_t)(const char *, struct statfs *);
    static fn_t real; REAL(real, "statfs");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), st);
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
    static fn_t real;
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

static bn_dns_config bn_dns;

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
    static open_fn ro; static read_fn rr;
    REAL(ro, "open"); REAL(rr, "read");
    if (!ro || !rr || cap == 0) return -1;

    char path[PATH_MAX];
    int fd = ro(bn_map(guest, path, sizeof path), O_RDONLY);
    if (fd < 0) return -1;
    ssize_t got = rr(fd, buf, cap - 1);
    int e = errno;
    typedef int (*close_fn)(int);
    static close_fn rc; REAL(rc, "close");
    if (rc) rc(fd);
    errno = e;
    if (got < 0) return -1;
    buf[got] = '\0';
    return got;
}

// st_mtim is glibc's; keep one spelling so the loader does not depend on macros.
static void bn_mtime_of(const char *guest, unsigned long *sec, unsigned long *nsec) {
    typedef int (*stat_fn)(const char *, struct stat *);
    static stat_fn rs; REAL(rs, "stat");
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
                    int v = atoi(o + 8);
                    if (v > 0) c->timeout_ms = v * 1000;
                } else if (!strncmp(o, "attempts:", 9)) {
                    int v = atoi(o + 9);
                    if (v > 0) c->attempts = v;
                } else if (!strncmp(o, "ndots:", 6)) {
                    int v = atoi(o + 6);
                    if (v >= 0) c->ndots = v;
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
    if (bn_dns.loaded && !force && bn_dns.rootfs_version == version) return;

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

// Re-read the configuration at most once a second, so a long-lived guest shell
// picks up a rewritten resolv.conf without a stat on every single lookup.
static void bn_dns_refresh(void) {
    if (bn_dns.check_countdown-- > 0) return;
    bn_dns.check_countdown = 64;
    bn_dns_load(0);
}

// ── wire format ────────────────────────────────────────────────────
static int bn_dns_build(unsigned char *buf, size_t cap, const char *name, uint16_t id, int qtype) {
    size_t n = 12;
    const char *p = name;
    if (cap < 12) return -1;

    buf[0] = (unsigned char)(id >> 8);
    buf[1] = (unsigned char)(id & 0xff);
    buf[2] = 0x01;  // recursion desired
    buf[3] = 0x00;
    buf[4] = 0x00; buf[5] = 0x01;
    memset(buf + 6, 0, 6);

    while (*p) {
        const char *dot = strchr(p, '.');
        size_t len = dot ? (size_t)(dot - p) : strlen(p);
        if (len == 0 || len > 63 || n + len + 2 > cap) return -1;
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
    static uint16_t next = 0x1234;
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
    static sock_fn rs; static conn_fn rc_; static send_fn rsnd; static recv_fn rrc;
    static poll_fn rpoll; static close_fn rcl; static int warned;
    REAL(rs, "socket"); REAL(rc_, "connect"); REAL(rsnd, "send"); REAL(rrc, "recv");
    REAL(rpoll, "poll"); REAL(rcl, "close");
    if (!rs || !rc_ || !rsnd || !rrc || !rpoll) {
        if (!warned++) DBG("dns: socket entry points unavailable\n");
        return -1;
    }

    int fd = rs(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
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

// TC answers need TCP; Debian's apt and git do hit that path.
static int bn_dns_tcp(const struct sockaddr_in *srv, const unsigned char *q, int qlen,
                      unsigned char *r, int rcap, int timeout_ms) {
    typedef int (*sock_fn)(int, int, int);
    typedef int (*conn_fn)(int, const struct sockaddr *, socklen_t);
    typedef int (*poll_fn)(struct pollfd *, nfds_t, int);
    typedef ssize_t (*rw_fn)(int, void *, size_t);
    typedef int (*close_fn)(int);
    static sock_fn rs; static conn_fn rcon; static poll_fn rpoll;
    static rw_fn rread; static rw_fn rwrite; static close_fn rcl; static int warned;
    REAL(rs, "socket"); REAL(rcon, "connect"); REAL(rpoll, "poll");
    REAL(rread, "read"); REAL(rwrite, "write"); REAL(rcl, "close");
    if (!rs || !rcon || !rpoll || !rread || !rwrite) {
        if (!warned++) DBG("dns: tcp entry points unavailable\n");
        return -1;
    }

    int fd = rs(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) return -1;

    int rc = rcon(fd, (const struct sockaddr *)srv, sizeof *srv);
    if (rc == 0) {
        unsigned char head[2];
        head[0] = (unsigned char)(qlen >> 8);
        head[1] = (unsigned char)(qlen & 0xff);
        if (rwrite(fd, head, 2) != 2 || rwrite(fd, (void *)q, (size_t)qlen) != qlen) rc = -1;
    }
    if (rc == 0) {
        unsigned char head[2];
        struct pollfd pfd;
        pfd.fd = fd;
        pfd.events = POLLIN;
        if (rpoll(&pfd, 1, timeout_ms) <= 0 || rread(fd, head, 2) != 2) rc = -1;
        else {
            int want = ((int)head[0] << 8) | head[1];
            int got = 0;
            if (want > rcap) rc = -1;
            while (rc == 0 && got < want) {
                pfd.revents = 0;
                if (rpoll(&pfd, 1, timeout_ms) <= 0) { rc = -1; break; }
                ssize_t n = rread(fd, r + got, (size_t)(want - got));
                if (n <= 0) { rc = -1; break; }
                got += (int)n;
            }
            if (rc == 0) { int g = got; if (rcl) rcl(fd); return g; }
        }
    }
    if (rcl) rcl(fd);
    return -1;
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
            if (r[2] & 0x02) {
                got = bn_dns_tcp(&bn_dns.server[i], q, qlen, r, sizeof r, bn_dns.timeout_ms);
                if (got < 0) continue;
            }
            if (bn_dns_parse(r, got, id, qtype, out) != 0) continue;
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
    if (bn_dns.ndots > 0 && dots < bn_dns.ndots && bn_dns.search_count > 0) {
        for (int i = 0; i < bn_dns.search_count; i++) {
            snprintf(buf, sizeof buf, "%s.%s", name, bn_dns.search[i]);
            if (bn_dns_query_one(buf, af == AF_INET6 ? 28 : 1, out) == 0 &&
                (out->v4_count || out->v6_count || out->rcode == 3))
                return 0;
        }
    }
    if (bn_dns_query_one(name, af == AF_INET6 ? 28 : 1, out) == 0) {
        if (out->v4_count || out->v6_count || out->rcode == 3) return 0;
        for (int i = 0; i < bn_dns.search_count; i++) {
            snprintf(buf, sizeof buf, "%s.%s", name, bn_dns.search[i]);
            if (bn_dns_query_one(buf, af == AF_INET6 ? 28 : 1, out) == 0 &&
                (out->v4_count || out->v6_count))
                return 0;
        }
        return 0;
    }
    for (int i = 0; i < bn_dns.search_count; i++) {
        snprintf(buf, sizeof buf, "%s.%s", name, bn_dns.search[i]);
        if (bn_dns_query_one(buf, af == AF_INET6 ? 28 : 1, out) == 0 &&
            (out->v4_count || out->v6_count))
            return 0;
    }
    return -1;
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
    static gai_fn real;
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
            DBG("dns: no nameserver configured for the guest, leaving lookup to libc\n");
            return -1;
        }
        if (bn_dns_query(node, af, &ans) != 0) return 0;   // transport failure
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

    char nums[BN_DNS_MAXV4 + BN_DNS_MAXV6][INET6_ADDRSTRLEN];
    int n = bn_resolve_to_numeric(node, af, nums, BN_DNS_MAXV4 + BN_DNS_MAXV6);
    if (n <= 0) {
        DBG("dns: %s unresolved in guest (n=%d), libc decides\n", node, n);
        return real(node, service, hints, res);
    }

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
    if (bn_resolve_to_numeric(name, af, nums, BN_DNS_MAXV4 + BN_DNS_MAXV6) <= 0)
        return real(name);
    return real(nums[0]);
}

struct hostent *gethostbyname(const char *name) {
    static ghbn_fn real;
    REAL(real, "gethostbyname");
    return bn_gethost_by_name(name, AF_INET, real);
}

struct hostent *gethostbyname2(const char *name, int af) {
    static ghbn_fn real;
    REAL(real, "gethostbyname2");
    return bn_gethost_by_name(name, af, real);
}

typedef int (*ghbn_r_fn)(const char *, struct hostent *, char *, size_t, struct hostent **, int *);

static int bn_gethost_by_name_r(ghbn_r_fn real, const char *name, struct hostent *ret, char *buf,
                                size_t buflen, struct hostent **result, int *h_errnop, int af) {
    if (!real) return EAI_SYSTEM;
    if (!name || !*name || !bn_dns_enabled()) return real(name, ret, buf, buflen, result, h_errnop);

    char num[INET6_ADDRSTRLEN];
    if (bn_numeric(name, af, num, sizeof num)) return real(name, ret, buf, buflen, result, h_errnop);

    char nums[BN_DNS_MAXV4 + BN_DNS_MAXV6][INET6_ADDRSTRLEN];
    if (bn_resolve_to_numeric(name, af, nums, BN_DNS_MAXV4 + BN_DNS_MAXV6) <= 0)
        return real(name, ret, buf, buflen, result, h_errnop);
    return real(nums[0], ret, buf, buflen, result, h_errnop);
}

int gethostbyname_r(const char *name, struct hostent *ret, char *buf, size_t buflen,
                    struct hostent **result, int *h_errnop) {
    static ghbn_r_fn real;
    REAL(real, "gethostbyname_r");
    return bn_gethost_by_name_r(real, name, ret, buf, buflen, result, h_errnop, AF_INET);
}

int gethostbyname2_r(const char *name, int af, struct hostent *ret, char *buf, size_t buflen,
                     struct hostent **result, int *h_errnop) {
    static ghbn_r_fn real;
    REAL(real, "gethostbyname2_r");
    return bn_gethost_by_name_r(real, name, ret, buf, buflen, result, h_errnop, af);
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

// Build the launcher command line for a guest shell. The child must not inherit
// LD_PRELOAD: a bionic process cannot load a glibc object.
static void bn_guest_shell_argv(const char *cmd, const char *launcher, const char *rootfs,
                                const char **argv) {
    argv[0] = launcher;
    argv[1] = "--rootfs";
    argv[2] = rootfs;
    argv[3] = "/bin/sh";
    argv[4] = "-c";
    argv[5] = cmd;
    argv[6] = NULL;
}

// Run `cmd` in the guest shell. Returns the raw wait status, or -1.
static int bn_run_shell(const char *cmd, int *pipe_end, int for_read) {
    typedef pid_t (*fork_fn)(void);
    typedef int (*execve_fn)(const char *, char *const[], char *const[]);
    typedef pid_t (*waitpid_fn)(pid_t, int *, int);
    typedef int (*pipe_fn)(int[2]);
    typedef int (*dup2_fn)(int, int);
    typedef int (*close_fn)(int);
    static fork_fn rfork; static execve_fn rexec; static waitpid_fn rwait;
    static pipe_fn rpipe; static dup2_fn rdup2; static close_fn rclose;
    REAL(rfork, "fork"); REAL(rexec, "execve"); REAL(rwait, "waitpid");
    REAL(rpipe, "pipe"); REAL(rdup2, "dup2"); REAL(rclose, "close");
    if (!rfork || !rexec || !rwait) return -1;

    const char *launcher = bn_env("BIONILUX_BINARY_PATH");
    const char *rootfs = bn_rootfs();
    if (!launcher || !rootfs) return -1;

    int fds[2] = {-1, -1};
    if (pipe_end && (!rpipe || rpipe(fds) != 0)) return -1;

    pid_t pid = rfork();
    if (pid < 0) {
        if (pipe_end) { rclose(fds[0]); rclose(fds[1]); }
        return -1;
    }
    if (pid == 0) {
        if (pipe_end) {
            if (rdup2 && rdup2(for_read ? fds[1] : fds[0],
                               for_read ? STDOUT_FILENO : STDIN_FILENO) < 0)
                _exit(127);
            rclose(fds[0]);
            rclose(fds[1]);
        }
        const char *argv[7];
        bn_guest_shell_argv(cmd, launcher, rootfs, argv);
        char **env = strip_ld_preload(environ);
        rexec(launcher, (char *const *)argv, env ? env : environ);
        _exit(127);
    }

    if (pipe_end) {
        rclose(fds[for_read ? 1 : 0]);
        *pipe_end = fds[for_read ? 0 : 1];
    }
    int status = 0;
    if (rwait(pid, &status, 0) < 0) return -1;
    return status;
}

int system(const char *cmd) {
    static int (*real)(const char *);
    REAL(real, "system");
    if (!cmd) return bn_dns_enabled() ? 1 : (real ? real(NULL) : 0);
    if (!bn_dns_enabled() || !bn_env("BIONILUX_BINARY_PATH"))
        return real ? real(cmd) : -1;

    DBG("system() -> guest shell: %s\n", cmd);
    return bn_run_shell(cmd, NULL, 0);
}

// popen() needs the child's pid at pclose() time; a small table is enough
// because popen streams are few and short-lived in practice.
#define BN_POPEN_MAX 32
static struct { FILE *fp; pid_t pid; } bn_popens[BN_POPEN_MAX];

FILE *popen(const char *cmd, const char *mode) {
    static FILE *(*real)(const char *, const char *);
    REAL(real, "popen");
    if (!cmd || !mode || !bn_dns_enabled() || !bn_env("BIONILUX_BINARY_PATH"))
        return real ? real(cmd, mode) : NULL;

    int for_read = (mode[0] == 'r');
    int fd = -1;
    // Fork once so the pipe end can be handed to fdopen only after the child
    // exists; bn_run_shell waits, so use a two-step: spawn, then read.
    typedef pid_t (*fork_fn)(void);
    typedef int (*execve_fn)(const char *, char *const[], char *const[]);
    typedef int (*pipe_fn)(int[2]);
    typedef int (*dup2_fn)(int, int);
    typedef int (*close_fn)(int);
    static fork_fn rfork; static execve_fn rexec; static pipe_fn rpipe;
    static dup2_fn rdup2; static close_fn rclose;
    REAL(rfork, "fork"); REAL(rexec, "execve"); REAL(rpipe, "pipe");
    REAL(rdup2, "dup2"); REAL(rclose, "close");
    if (!rfork || !rexec || !rpipe) return real ? real(cmd, mode) : NULL;

    const char *launcher = bn_env("BIONILUX_BINARY_PATH");
    const char *rootfs = bn_rootfs();
    if (!launcher || !rootfs) return real ? real(cmd, mode) : NULL;

    int fds[2] = {-1, -1};
    if (rpipe(fds) != 0) return NULL;

    pid_t pid = rfork();
    if (pid < 0) { rclose(fds[0]); rclose(fds[1]); return NULL; }
    if (pid == 0) {
        rdup2(fds[for_read ? 1 : 0], for_read ? STDOUT_FILENO : STDIN_FILENO);
        rclose(fds[0]);
        rclose(fds[1]);
        const char *argv[7];
        bn_guest_shell_argv(cmd, launcher, rootfs, argv);
        char **env = strip_ld_preload(environ);
        rexec(launcher, (char *const *)argv, env ? env : environ);
        _exit(127);
    }
    rclose(fds[for_read ? 1 : 0]);
    fd = fds[for_read ? 0 : 1];

    FILE *fp = fdopen(fd, mode);
    if (!fp) { rclose(fd); return NULL; }
    for (int i = 0; i < BN_POPEN_MAX; i++) {
        if (!bn_popens[i].fp) { bn_popens[i].fp = fp; bn_popens[i].pid = pid; break; }
    }
    DBG("popen(%s) -> guest shell\n", cmd);
    return fp;
}

int pclose(FILE *fp) {
    static int (*real)(FILE *);
    REAL(real, "pclose");
    typedef pid_t (*waitpid_fn)(pid_t, int *, int);
    static waitpid_fn rwait; REAL(rwait, "waitpid");

    for (int i = 0; i < BN_POPEN_MAX; i++) {
        if (bn_popens[i].fp != fp) continue;
        pid_t pid = bn_popens[i].pid;
        bn_popens[i].fp = NULL;
        fclose(fp);
        int status = 0;
        if (rwait && rwait(pid, &status, 0) < 0) return -1;
        return status;
    }
    return real ? real(fp) : -1;
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

        size_t need = strlen(fields[0]) + strlen(fields[1]) + strlen(fields[3]) + 4;
        if (need > buflen) return -2;
        char *w = buf;
        gr->gr_name = w; w = stpcpy(w, fields[0]) + 1;
        gr->gr_passwd = w; w = stpcpy(w, fields[1]) + 1;
        gr->gr_gid = (gid_t)strtoul(fields[2], NULL, 10);
        // The member list is handed back empty: nothing in the package
        // machinery depends on it, and the caller's buffer stays simple.
        gr->gr_mem = (char **)w;
        ((char **)w)[0] = NULL;
        *result = gr;
        return 0;
    }
    return -1;
}

static int (*bn_real_getpwnam_r(void))(const char *, struct passwd *, char *, size_t,
                                       struct passwd **) {
    static pw_get_fn r;
    REAL(r, "getpwnam_r");
    return r;
}
static int (*bn_real_getpwuid_r(void))(uid_t, struct passwd *, char *, size_t, struct passwd **) {
    static pw_uid_fn r;
    REAL(r, "getpwuid_r");
    return r;
}
static int (*bn_real_getgrnam_r(void))(const char *, struct group *, char *, size_t,
                                       struct group **) {
    static gr_get_fn r;
    REAL(r, "getgrnam_r");
    return r;
}
static int (*bn_real_getgrgid_r(void))(gid_t, struct group *, char *, size_t, struct group **) {
    static gr_gid_fn r;
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
    if (!name || !bn_dns_enabled()) {
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
    if (!bn_dns_enabled()) {
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
    if (!name || !bn_dns_enabled()) {
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
    if (!bn_dns_enabled()) {
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
    static struct passwd *(*real)(const char *);
    REAL(real, "getpwnam");
    if (!bn_dns_enabled()) return real ? real(name) : NULL;
    struct passwd *out = NULL;
    return getpwnam_r(name, &bn_pw_static, bn_pw_buf, sizeof bn_pw_buf, &out) == 0 ? out
                                                                                  : (real ? real(name) : NULL);
}

struct passwd *getpwuid(uid_t uid) {
    static struct passwd *(*real)(uid_t);
    REAL(real, "getpwuid");
    if (!bn_dns_enabled()) return real ? real(uid) : NULL;
    struct passwd *out = NULL;
    return getpwuid_r(uid, &bn_pw_static, bn_pw_buf, sizeof bn_pw_buf, &out) == 0 ? out
                                                                                  : (real ? real(uid) : NULL);
}

struct group *getgrnam(const char *name) {
    static struct group *(*real)(const char *);
    REAL(real, "getgrnam");
    if (!bn_dns_enabled()) return real ? real(name) : NULL;
    struct group *out = NULL;
    return getgrnam_r(name, &bn_gr_static, bn_gr_buf, sizeof bn_gr_buf, &out) == 0 ? out
                                                                                   : (real ? real(name) : NULL);
}

struct group *getgrgid(gid_t gid) {
    static struct group *(*real)(gid_t);
    REAL(real, "getgrgid");
    if (!bn_dns_enabled()) return real ? real(gid) : NULL;
    struct group *out = NULL;
    return getgrgid_r(gid, &bn_gr_static, bn_gr_buf, sizeof bn_gr_buf, &out) == 0 ? out
                                                                                  : (real ? real(gid) : NULL);
}

#pragma GCC diagnostic pop

__attribute__((constructor)) static void on_init(void) {
    DBG("Injection successful! rootfs=%s\n",
        bn_rootfs() ? bn_rootfs() : "(none)");
}
