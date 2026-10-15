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

// Build [launcher, target, argv[1..]] with a stripped envp.
static int reroute(const char *target, char *const argv[], char *const envp[],
                   const char **launcher, char ***nargv, char ***nenvp) {
    *launcher = getenv("BIONILUX_BINARY_PATH");
    if (!*launcher || !target || is_launcher(target, *launcher)) return 0;

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
    if (reroute(path, argv, envp, &l, &av, &ev))
        return run_rerouted(l, av, ev);
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
    if (reroute(file, argv, environ, &l, &av, &ev))
        return run_rerouted(l, av, ev);
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
    char link[64];
    int n = snprintf(link, sizeof link, "/proc/self/fd/%d", fd);
    if (n < 0 || (size_t)n >= sizeof link) return -1;
    ssize_t r = readlink(link, buf, size);
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
    if (reroute(path, argv, envp, &l, &av, &ev)) {
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
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), st);
}

int lstat(const char *path, struct stat *st) {
    typedef int (*fn_t)(const char *, struct stat *);
    static fn_t real; REAL(real, "lstat");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), st);
}

int stat64(const char *path, struct stat64 *st) {
    typedef int (*fn_t)(const char *, struct stat64 *);
    static fn_t real; REAL(real, "stat64");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), st);
}

int lstat64(const char *path, struct stat64 *st) {
    typedef int (*fn_t)(const char *, struct stat64 *);
    static fn_t real; REAL(real, "lstat64");
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), st);
}

int fstatat(int dirfd, const char *path, struct stat *st, int flags) {
    typedef int (*fn_t)(int, const char *, struct stat *, int);
    static fn_t real; REAL(real, "fstatat");
    char buf[PATH_MAX];
    const char *t = bn_resolve(dirfd, path, buf, sizeof buf);
    return real(dirfd, t, st, flags);
}

int fstatat64(int dirfd, const char *path, struct stat64 *st, int flags) {
    typedef int (*fn_t)(int, const char *, struct stat64 *, int);
    static fn_t real; REAL(real, "fstatat64");
    char buf[PATH_MAX];
    const char *t = bn_resolve(dirfd, path, buf, sizeof buf);
    return real(dirfd, t, st, flags);
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
    return real(dirfd, bn_resolve(dirfd, path, buf, sizeof buf), flags, mask, st);
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

int link(const char *from, const char *to) {
    typedef int (*fn_t)(const char *, const char *);
    static fn_t real; REAL(real, "link");
    char b1[PATH_MAX], b2[PATH_MAX];
    const char *f = bn_resolve(AT_FDCWD, from, b1, sizeof b1);
    const char *t = bn_resolve(AT_FDCWD, to, b2, sizeof b2);
    return real(f, t);
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
    return real(ofd, f, nfd, t, flags);
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
    if (strcmp(path, "/proc/self/exe") == 0) {
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
static uid_t bn_vruid, bn_veuid, bn_vsuid;
static gid_t bn_vrgid, bn_vegid, bn_vsgid;

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

__attribute__((constructor)) static void on_init(void) {
    DBG("Injection successful! rootfs=%s\n",
        bn_rootfs() ? bn_rootfs() : "(none)");
}
