// bionilux LD_PRELOAD hooks (glibc side). Reroutes exec*/posix_spawn* through
// the launcher, redirects /etc/* to the glibc sysroot, and fakes /proc/self/exe.
// Gaps: bare-name execvp/posix_spawnp fail after exec (127 not ENOENT);
//       execveat(dirfd, rel) runs natively; target argv[0] is the resolved
//       path; user LD_PRELOAD is dropped for rerouted children.
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <spawn.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

extern char **environ;

// Debug output. Cached so we don't re-check the environment on every call,
// and empty BIONILUX_DEBUG= disables output.
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

// Lazily resolve the next symbol `name` into `var` (cached).
#define REAL(var, name) \
    do { if (!(var)) (var) = (__typeof__(var))dlsym(RTLD_NEXT, name); } while (0)

static int is_launcher(const char *path, const char *launcher) {
    return launcher && path && strcmp(path, launcher) == 0;
}

// Copy of envp without LD_PRELOAD. NULL only on OOM.
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
// Returns 1 on reroute (caller frees *nargv / *nenvp), 0 to pass through.
static int reroute(const char *target, char *const argv[], char *const envp[],
                   const char **launcher, char ***nargv, char ***nenvp) {
    *launcher = getenv("BIONILUX_BINARY_PATH");
    if (!*launcher || !target || is_launcher(target, *launcher)) return 0;

    // Missing path: pass through so the caller sees ENOENT synchronously.
    if (strchr(target, '/') && access(target, X_OK) != 0) return 0;

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

// exec() the launcher with the arrays from reroute(), preserving errno.
static int run_rerouted(const char *launcher, char **av, char **ev) {
    int r = real_execve(launcher, av, ev);
    int e = errno;
    free(av);
    free(ev);
    errno = e;
    return r;
}

// exec() the launcher itself with a bionic-safe envp.
static int exec_launcher(const char *path, char *const argv[], char *const envp[]) {
    char **clean = strip_ld_preload(envp);
    int r = real_execve(path, argv, clean ? clean : envp);
    int e = errno;
    free(clean);
    errno = e;
    return r;
}

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
// (where va_list is a struct, not an array). Caller frees.
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
    va_list ap;
    va_start(ap, arg0);
    char **argv = va_to_argv(arg0, &ap);
    va_end(ap);
    if (!argv) { errno = ENOMEM; return -1; }

    int r = execve(path, argv, environ);
    int e = errno;
    free(argv);
    errno = e;
    return r;
}

int execlp(const char *file, const char *arg0, ...) {
    va_list ap;
    va_start(ap, arg0);
    char **argv = va_to_argv(arg0, &ap);
    va_end(ap);
    if (!argv) { errno = ENOMEM; return -1; }

    int r = execvp(file, argv);
    int e = errno;
    free(argv);
    errno = e;
    return r;
}

int execle(const char *path, const char *arg0, ...) {
    va_list ap;
    va_start(ap, arg0);
    char **argv = va_to_argv(arg0, &ap);
    (void)va_arg(ap, char *);  // consume trailing NULL
    char *const *envp = va_arg(ap, char *const *);
    va_end(ap);
    if (!argv) { errno = ENOMEM; return -1; }

    int r = execve(path, argv, envp);
    int e = errno;
    free(argv);
    errno = e;
    return r;
}

// /proc/self/fd/N -> real path. -1 for memfd/(deleted) or on error.
static ssize_t resolve_fd_path(int fd, char *buf, size_t size) {
    char link[64];
    int n = snprintf(link, sizeof link, "/proc/self/fd/%d", fd);
    if (n < 0 || (size_t)n >= sizeof link) return -1;

    // Our own readlink hook ignores this path, so it's safe to call.
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

    errno = ENOSYS;
    return -1;
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
        }
    }
    if (real) return real(dirfd, path, argv, envp, flags);

    errno = ENOSYS;
    return -1;
}

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
        int e = errno;
        free(clean);
        errno = e;
        return r;
    }

    const char *l; char **av, **ev;
    if (reroute(path, argv, envp, &l, &av, &ev)) {
        int r = plain(pid, l, fa, attr, av, ev);
        int e = errno;
        free(av); free(ev);
        errno = e;
        return r;
    }

    if (search_path) {
        typedef int (*fn_t)(pid_t *, const char *, const posix_spawn_file_actions_t *,
                            const posix_spawnattr_t *, char *const[], char *const[]);
        static fn_t real;
        REAL(real, "posix_spawnp");
        if (real) return real(pid, path, fa, attr, argv, envp);
        errno = ENOSYS;
        return -1;
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

// ── /etc/* -> $GLIBC/etc/* redirection ─────────────────────────────
// Termux has no /etc/resolv.conf, /etc/hosts, /etc/nsswitch.conf.
// glibc's NSS and resolver look them up there.
static const char *glibc_prefix(void) {
    static const char *cached;
    if (!cached) {
        cached = getenv("BIONILUX_GLIBC_PREFIX");
        if (!cached || !cached[0])
            cached = "/data/data/com.termux/files/usr/glibc";
    }
    return cached;
}

static const char *redirect_etc(const char *path, char *buf, size_t size) {
    if (path[0] != '/' || strncmp(path, "/etc/", 5) != 0)
        return path;

    int n = snprintf(buf, size, "%s%s", glibc_prefix(), path);
    if (n <= 0 || (size_t)n >= size) return path;
    if (access(buf, F_OK) != 0) return path;
    return buf;
}

// O_TMPFILE does not include O_CREAT but the mode argument is still used.
static int open_uses_mode(int flags) {
#ifdef O_TMPFILE
    if ((flags & O_TMPFILE) == O_TMPFILE) return 1;
#endif
    return (flags & O_CREAT) != 0;
}

typedef int (*open_fn)(const char *, int, ...);
typedef int (*openat_fn)(int, const char *, int, ...);

int open(const char *path, int flags, ...) {
    static open_fn real;
    REAL(real, "open");

    char buf[PATH_MAX];
    const char *t = redirect_etc(path, buf, sizeof buf);

    if (open_uses_mode(flags)) {
        va_list ap; va_start(ap, flags);
        mode_t mode = va_arg(ap, mode_t);
        va_end(ap);
        return real(t, flags, mode);
    }
    return real(t, flags);
}

int open64(const char *path, int flags, ...) {
    static open_fn real;
    REAL(real, "open64");

    char buf[PATH_MAX];
    const char *t = redirect_etc(path, buf, sizeof buf);

    if (open_uses_mode(flags)) {
        va_list ap; va_start(ap, flags);
        mode_t mode = va_arg(ap, mode_t);
        va_end(ap);
        return real(t, flags, mode);
    }
    return real(t, flags);
}

int openat(int dirfd, const char *path, int flags, ...) {
    static openat_fn real;
    REAL(real, "openat");

    char buf[PATH_MAX];
    const char *t = (path[0] == '/') ? redirect_etc(path, buf, sizeof buf) : path;

    if (open_uses_mode(flags)) {
        va_list ap; va_start(ap, flags);
        mode_t mode = va_arg(ap, mode_t);
        va_end(ap);
        return real(dirfd, t, flags, mode);
    }
    return real(dirfd, t, flags);
}

int openat64(int dirfd, const char *path, int flags, ...) {
    static openat_fn real;
    REAL(real, "openat64");

    char buf[PATH_MAX];
    const char *t = (path[0] == '/') ? redirect_etc(path, buf, sizeof buf) : path;

    if (open_uses_mode(flags)) {
        va_list ap; va_start(ap, flags);
        mode_t mode = va_arg(ap, mode_t);
        va_end(ap);
        return real(dirfd, t, flags, mode);
    }
    return real(dirfd, t, flags);
}

// Fake /proc/self/exe so programs see their real path, not ld.so's.
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
    static fn_t real;
    REAL(real, "readlinkat");

    if (strcmp(path, "/proc/self/exe") == 0) {
        ssize_t r = fake_exe(buf, size);
        if (r >= 0) return r;
    }
    return real(dirfd, path, buf, size);
}

ssize_t readlink(const char *path, char *buf, size_t size) {
    return readlinkat(AT_FDCWD, path, buf, size);
}

__attribute__((constructor)) static void on_init(void) {
    DBG("Injection successful!\n");
}