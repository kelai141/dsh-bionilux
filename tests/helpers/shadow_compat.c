// Probe for the shadow compatibility fragment.
//
// This is deliberately a separate process from the preload.  It exercises
// real fcntl locks and simulates Android's hard-link refusal with seccomp, so
// the copy fallback and its narrow nlink view are tested through the public
// stat/link entry points rather than through fragment internals.
#define _GNU_SOURCE
#include <assert.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <shadow.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

static long long now_ms(void) {
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) return -1;
    return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static void sleep_ms(long milliseconds) {
    struct timespec ts = {
        .tv_sec = milliseconds / 1000,
        .tv_nsec = (milliseconds % 1000) * 1000000
    };
    while (nanosleep(&ts, &ts) != 0 && errno == EINTR) {}
}

static void ready(void) {
    const char *path = getenv("BN_SHADOW_READY");
    if (!path) path = "/tmp/shadow-ready";
    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd < 0) { perror("ready"); exit(2); }
    if (write(fd, "1\n", 2) != 2) { perror("ready write"); exit(2); }
    close(fd);
}

static void write_source(const char *path, const char *contents) {
    int fd = open(path, O_WRONLY | O_CREAT | O_EXCL, 0640);
    if (fd < 0) { perror(path); exit(2); }
    size_t len = strlen(contents);
    if (write(fd, contents, len) != (ssize_t)len) { perror("write source"); exit(2); }
    close(fd);
}

static void check_contents(const char *path, const char *expected) {
    char buf[128] = {0};
    int fd = open(path, O_RDONLY);
    if (fd < 0) { perror(path); exit(3); }
    ssize_t got = read(fd, buf, sizeof buf - 1);
    close(fd);
    if (got != (ssize_t)strlen(expected) || strcmp(buf, expected)) {
        fprintf(stderr, "%s: copied contents differ\n", path);
        exit(3);
    }
}

static int deny_link_syscalls(void) {
    struct sock_filter filter[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS,
                 (unsigned int)offsetof(struct seccomp_data, arch)),
#if defined(__x86_64__)
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 0, 6),
#elif defined(__aarch64__)
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_AARCH64, 0, 6),
#else
#error "add the test architecture's AUDIT_ARCH value"
#endif
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS,
                 (unsigned int)offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_link, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_linkat, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA)),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA)),
    };
    struct sock_fprog program = {
        .len = (unsigned short)(sizeof filter / sizeof filter[0]),
        .filter = filter
    };
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return -1;
    return prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program);
}

static int lock_hold(long milliseconds) {
    if (lckpwdf() != 0) { perror("lckpwdf hold"); return 1; }
    ready();
    sleep_ms(milliseconds);
    if (ulckpwdf() != 0) { perror("ulckpwdf hold"); return 1; }
    return 0;
}

static int lock_wait(long minimum, long maximum, int expect_success) {
    long long start = now_ms();
    int rc = lckpwdf();
    int error = errno;
    long long elapsed = now_ms() - start;
    printf("lckpwdf=%d errno=%d elapsed_ms=%lld\n", rc, error, elapsed);

    if (expect_success) {
        if (rc != 0) { fprintf(stderr, "lock was not acquired\n"); return 1; }
        if (ulckpwdf() != 0) { perror("ulckpwdf wait"); return 1; }
    } else if (rc == 0) {
        fprintf(stderr, "lock unexpectedly acquired\n");
        ulckpwdf();
        return 1;
    } else if (error != EAGAIN) {
        fprintf(stderr, "unexpected lock error: %s\n", strerror(error));
        return 1;
    }

    if (minimum > 0 && elapsed < minimum) {
        fprintf(stderr, "returned too early: %lld ms < %ld ms\n", elapsed, minimum);
        return 1;
    }
    if (maximum > 0 && elapsed > maximum) {
        fprintf(stderr, "timeout was not bounded: %lld ms > %ld ms\n", elapsed, maximum);
        return 1;
    }
    return 0;
}

static int same_process(void) {
    if (lckpwdf() != 0) { perror("first lckpwdf"); return 1; }
    // As in glibc, a second lock in the same process fails without touching
    // the descriptor held by the first.
    if (lckpwdf() != -1) {
        fprintf(stderr, "second lock succeeded\n");
        return 1;
    }
    if (ulckpwdf() != 0) { perror("first ulckpwdf"); return 1; }
    if (ulckpwdf() != -1) {
        fprintf(stderr, "second unlock unexpectedly succeeded\n");
        return 1;
    }
    return 0;
}

static int protocol_copy(void) {
    char source[64], lock[64], again[64], other_source[64], other_lock[64];
    long pid = (long)getpid();
    snprintf(source, sizeof source, "/etc/group.%ld", pid);
    snprintf(lock, sizeof lock, "/etc/group.lock");
    snprintf(again, sizeof again, "/etc/group.%ld", pid);
    snprintf(other_source, sizeof other_source, "/etc/other.%ld", pid);
    snprintf(other_lock, sizeof other_lock, "/etc/other.lock");

    write_source(source, "guest:x:101:\n");
    if (link(source, lock) != 0) { perror("protocol link fallback"); return 1; }

    struct stat src, dst;
    if (stat(source, &src) != 0 || stat(lock, &dst) != 0) {
        perror("protocol stat"); return 1;
    }
    if (src.st_ino == dst.st_ino) {
        fprintf(stderr, "test did not exercise the copy fallback\n"); return 1;
    }
    if (src.st_nlink != 2) {
        fprintf(stderr, "protocol source nlink=%ju, expected 2\n",
                (uintmax_t)src.st_nlink);
        return 1;
    }
    if (dst.st_nlink != 1) {
        fprintf(stderr, "lock target nlink=%ju, expected 1\n",
                (uintmax_t)dst.st_nlink);
        return 1;
    }

    // fstat has no source name and must keep the physical link count.
    int fd = open(source, O_RDONLY);
    if (fd < 0 || fstat(fd, &src) != 0) { perror("protocol fstat"); return 1; }
    close(fd);
    if (src.st_nlink != 1) {
        fprintf(stderr, "fstat changed the link count to %ju\n",
                (uintmax_t)src.st_nlink);
        return 1;
    }
    check_contents(lock, "guest:x:101:\n");

    // Shadow checks nlink, then unlinks its temporary source.  The record must
    // disappear with that unlink.
    if (unlink(source) != 0) { perror("unlink protocol source"); return 1; }
    write_source(again, "guest:x:101:\n");
    if (stat(again, &src) != 0 || src.st_nlink != 1) {
        fprintf(stderr, "record survived source unlink (nlink=%ju)\n",
                (uintmax_t)src.st_nlink);
        return 1;
    }
    if (unlink(lock) != 0 || unlink(again) != 0) {
        perror("protocol cleanup"); return 1;
    }

    // Unlinking the target first must also clear the source view.
    write_source(source, "guest:x:102:\n");
    if (link(source, lock) != 0) { perror("second protocol fallback"); return 1; }
    if (stat(source, &src) != 0 || src.st_nlink != 2) {
        fprintf(stderr, "second protocol copy lacks nlink 2\n"); return 1;
    }
    if (unlink(lock) != 0) { perror("unlink protocol target"); return 1; }
    if (stat(source, &src) != 0 || src.st_nlink != 1) {
        fprintf(stderr, "record survived target unlink\n"); return 1;
    }
    if (unlink(source) != 0) { perror("second protocol cleanup"); return 1; }

    // Every other copy remains an ordinary file with nlink 1.
    write_source(other_source, "unrelated\n");
    if (link(other_source, other_lock) != 0) { perror("non-protocol fallback"); return 1; }
    if (stat(other_source, &src) != 0 || src.st_nlink != 1) {
        fprintf(stderr, "non-protocol copy got a virtual link count\n"); return 1;
    }
    if (unlink(other_source) != 0 || unlink(other_lock) != 0) {
        perror("non-protocol cleanup"); return 1;
    }

    puts("shadow copy protocol: narrow nlink 2, ordinary files unchanged, cleanup: OK");
    return 0;
}

static int host_passthrough(void) {
    struct stat st, raw;
    if (stat("/etc/passwd", &st) != 0) { perror("host stat"); return 1; }
    if (syscall(SYS_newfstatat, AT_FDCWD, "/etc/passwd", &raw, 0) != 0) {
        perror("raw host stat"); return 1;
    }
    if (st.st_nlink != raw.st_nlink || st.st_ino != raw.st_ino) {
        fprintf(stderr, "host stat was modified outside a guest\n"); return 1;
    }

    char path[] = "/tmp/shadow-host-XXXXXX";
    int fd = mkstemp(path);
    if (fd < 0) { perror("mkstemp"); return 1; }
    close(fd);
    if (stat(path, &st) != 0 || st.st_nlink != 1) {
        fprintf(stderr, "host temporary file nlink changed\n"); return 1;
    }
    unlink(path);

    typedef unsigned long (*nlink_fn)(dev_t, ino_t, unsigned long, int, const char *);
    nlink_fn helper = (nlink_fn)dlsym(RTLD_DEFAULT, "bn_shadow_nlink");
    if (helper && helper(1, 2, 7, AT_FDCWD, "/etc/passwd") != 7) {
        fprintf(stderr, "nlink helper changed a host result\n"); return 1;
    }
    puts("host non-guest stat/nlink passthrough: OK");
    return 0;
}

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: %s sameproc|lock-hold MS|lock-wait MIN MAX OK|FAIL|protocol|host\n", argv[0]);
        return 2;
    }
    if (!strcmp(argv[1], "sameproc")) return same_process();
    if (!strcmp(argv[1], "lock-hold") && argc == 3) return lock_hold(atol(argv[2]));
    if (!strcmp(argv[1], "lock-wait") && argc == 5)
        return lock_wait(atol(argv[2]), atol(argv[3]), !strcmp(argv[4], "OK"));
    if (!strcmp(argv[1], "protocol")) {
        if (deny_link_syscalls() != 0) { perror("seccomp link denial"); return 2; }
        return protocol_copy();
    }
    if (!strcmp(argv[1], "host")) return host_passthrough();
    fprintf(stderr, "invalid arguments\n");
    return 2;
}
