#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

#if defined(SYS_newfstatat)
#define BN_NEWFSTATAT SYS_newfstatat
#elif defined(SYS_fstatat)
#define BN_NEWFSTATAT SYS_fstatat
#endif

static int read_text(const char *path, char *buf, size_t size) {
    int fd = open(path, O_RDONLY);
    if (fd < 0) return -1;
    ssize_t n = read(fd, buf, size - 1);
    int saved = errno;
    close(fd);
    if (n < 0) { errno = saved; return -1; }
    buf[n] = '\0';
    while (n > 0 && (buf[n - 1] == '\n' || buf[n - 1] == '\r')) buf[--n] = '\0';
    return 0;
}

static void print_rc(const char *key, long rc, const char *payload) {
    if (rc == 0) printf("%s=ok%s%s\n", key, payload && *payload ? ":" : "", payload ? payload : "");
    else printf("%s=errno:%d\n", key, errno);
}

__attribute__((noinline))
static long raw_statx(int dirfd, const char *path, int flags, unsigned mask,
                      struct statx *st) {
#if defined(__x86_64__)
    long ret;
    register long r10 __asm__("r10") = (long)mask;
    register long r8 __asm__("r8") = (long)(uintptr_t)st;
    __asm__ volatile("syscall"
                     : "=a"(ret)
                     : "a"((long)SYS_statx), "D"((long)dirfd),
                       "S"((long)(uintptr_t)path), "d"((long)flags),
                       "r"(r10), "r"(r8)
                     : "rcx", "r11", "memory");
    return ret;
#else
    register long x8 __asm__("x8") = SYS_statx;
    register long x0 __asm__("x0") = dirfd;
    register long x1 __asm__("x1") = (long)(uintptr_t)path;
    register long x2 __asm__("x2") = flags;
    register long x3 __asm__("x3") = mask;
    register long x4 __asm__("x4") = (long)(uintptr_t)st;
    __asm__ volatile("svc 0"
                     : "+r"(x0)
                     : "r"(x1), "r"(x2), "r"(x3), "r"(x4), "r"(x8)
                     : "memory");
    return x0;
#endif
}

static long raw_result(long ret) {
    if (ret < 0 && ret >= -4095) {
        errno = (int)-ret;
        return -1;
    }
    return ret;
}

int main(void) {
    const char *guest = getenv("BN_SYSCALL_GUEST");
    const char *host = getenv("BN_SYSCALL_HOST");
    const char *link = getenv("BN_SYSCALL_LINK");
    const char *link_target = getenv("BN_SYSCALL_LINK_TARGET");
    const char *exe_target = getenv("BIONILUX_TARGET_EXE");
    char text[256];

    struct statx sx;
    memset(&sx, 0, sizeof sx);
    errno = 0;
    long rc = syscall(SYS_statx, AT_FDCWD, guest, 0, STATX_BASIC_STATS, &sx);
    if (rc == 0 && read_text(guest, text, sizeof text) == 0)
        print_rc("statx_guest", 0, text);
    else
        print_rc("statx_guest", -1, NULL);
    printf("statx_uid=%u\n", (unsigned)sx.stx_uid);
    printf("statx_gid=%u\n", (unsigned)sx.stx_gid);

    memset(&sx, 0, sizeof sx);
    errno = 0;
    rc = syscall(SYS_statx, AT_FDCWD, host, 0, STATX_BASIC_STATS, &sx);
    if (rc == 0 && read_text(host, text, sizeof text) == 0)
        print_rc("statx_host", 0, text);
    else
        print_rc("statx_host", -1, NULL);

    int fd = open(guest, O_RDONLY);
    if (fd >= 0) {
        memset(&sx, 0, sizeof sx);
        errno = 0;
        rc = syscall(SYS_statx, fd, "", AT_EMPTY_PATH, STATX_BASIC_STATS, &sx);
        close(fd);
        print_rc("statx_empty", rc, NULL);
    } else {
        print_rc("statx_empty", -1, NULL);
    }

#ifdef BN_NEWFSTATAT
    struct stat st;
    memset(&st, 0, sizeof st);
    errno = 0;
    rc = syscall(BN_NEWFSTATAT, AT_FDCWD, guest, &st, 0);
    print_rc("newfstatat_guest", rc, NULL);
    printf("newfstatat_uid=%u\n", (unsigned)st.st_uid);
    printf("newfstatat_gid=%u\n", (unsigned)st.st_gid);
#endif

    errno = 0;
    fd = (int)syscall(SYS_openat, AT_FDCWD, guest, O_RDONLY, 0);
    if (fd >= 0 && read_text(guest, text, sizeof text) == 0) {
        print_rc("openat_guest", 0, text);
        close(fd);
    } else {
        print_rc("openat_guest", -1, NULL);
    }

    if (link && *link) {
        char target[256];
        memset(target, 0, sizeof target);
        errno = 0;
        rc = syscall(SYS_readlinkat, AT_FDCWD, link, target, sizeof target - 1);
        if (rc >= 0) {
            target[rc] = '\0';
            printf("readlinkat_guest=%s\n", target);
        } else {
            printf("readlinkat_guest=errno:%d\n", errno);
        }
    }

    char exe[256];
    memset(exe, 0, sizeof exe);
    errno = 0;
    rc = syscall(SYS_readlinkat, AT_FDCWD, "/proc/self/exe", exe, sizeof exe - 1);
    if (rc >= 0) { exe[rc] = '\0'; printf("readlink_exe=%s\n", exe); }
    else printf("readlink_exe=errno:%d\n", errno);

    errno = 0;
    rc = syscall(SYS_getpid);
    printf("unknown_0=%s\n", rc > 0 ? "ok" : "fail");

    errno = 0;
    rc = syscall(SYS_close, -1);
    printf("unknown_1=%s:%d\n", rc == -1 ? "errno" : "fail", errno);

    errno = 0;
    rc = syscall(SYS_kill, getpid(), 0);
    printf("unknown_2=%s\n", rc == 0 ? "ok" : "fail");

    char rnd[16];
    errno = 0;
    rc = syscall(SYS_getrandom, rnd, sizeof rnd, 0);
    printf("unknown_3=%s\n", rc > 0 ? "ok" : "fail");

    sigset_t set;
    sigemptyset(&set);
    errno = 0;
    rc = syscall(SYS_rt_sigprocmask, SIG_BLOCK, &set, NULL, 8);
    printf("unknown_4=%s\n", rc == 0 ? "ok" : "fail");

    errno = 0;
    rc = syscall(SYS_prctl, PR_GET_DUMPABLE, 0, 0, 0, 0);
    printf("unknown_5=%s\n", rc >= 0 ? "ok" : "fail");

    errno = 0;
    void *page = (void *)syscall(SYS_mmap, 0, 4096, PROT_READ | PROT_WRITE,
                                 MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (page != MAP_FAILED) {
        ((char *)page)[0] = 'x';
        syscall(SYS_munmap, page, 4096);
    }
    printf("unknown_6=%s\n", page != MAP_FAILED ? "ok" : "fail");

    pid_t pid = fork();
    if (pid == 0) _exit(syscall(SYS_getpid) > 0 ? 0 : 1);
    int status = 0;
    if (pid > 0 && waitpid(pid, &status, 0) == pid && WIFEXITED(status) && WEXITSTATUS(status) == 0)
        puts("fork=ok");
    else
        puts("fork=fail");

    pid = vfork();
    if (pid == 0) _exit(0);
    status = 0;
    if (pid > 0 && waitpid(pid, &status, 0) == pid && WIFEXITED(status) && WEXITSTATUS(status) == 0)
        puts("vfork=ok");
    else
        puts("vfork=fail");

    memset(&sx, 0, sizeof sx);
    errno = 0;
    rc = raw_result(raw_statx(AT_FDCWD, guest, 0, STATX_BASIC_STATS, &sx));
    printf("raw_statx_guest=%s:%d\n", rc == 0 ? "ok" : "errno", errno);

    (void)link_target;
    (void)exe_target;
    return 0;
}
