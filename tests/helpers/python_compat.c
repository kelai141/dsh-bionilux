// Native probes for the Python compatibility hooks.
//
// This program is intentionally not linked against hooks.c.  It is run with
// LD_PRELOAD so every symbol below is the exported interposer, exactly as a
// Python extension sees it.  The shell driver supplies a synthetic rootfs.

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <pthread.h>
#include <semaphore.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <sys/xattr.h>
#include <unistd.h>

static void fail(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    fputs("FAIL: ", stderr);
    vfprintf(stderr, fmt, ap);
    fputc('\n', stderr);
    va_end(ap);
    exit(1);
}

static void require(int condition, const char *what) {
    if (!condition)
        fail("%s (errno=%d: %s)", what, errno, strerror(errno));
}

static void expect_fail(int rc, int expected, const char *what) {
    int saved = errno;
    if (rc != -1 || saved != expected)
        fail("%s: rc=%d errno=%d (%s), expected -1/%d (%s)", what, rc, saved,
             strerror(saved), expected, strerror(expected));
}

static const char *test_root(void) {
    const char *root = getenv("BN_TEST_ROOT");
    if (!root || !*root) fail("BN_TEST_ROOT is not set");
    return root;
}

static void physical(const char *guest, char *out, size_t size) {
    int n = snprintf(out, size, "%s%s", test_root(), guest);
    if (n < 0 || (size_t)n >= size) fail("physical path too long");
}

// /proc is a passthrough prefix, so /proc/self/root/tmp/x reaches the host's
// /tmp/x even while every ordinary guest path is mapped into the rootfs.
static void host_view(const char *guest, char *out, size_t size) {
    int n = snprintf(out, size, "/proc/self/root%s", guest);
    if (n < 0 || (size_t)n >= size) fail("host view path too long");
}

static void make_file(const char *path, const char *contents) {
    int fd = open(path, O_CREAT | O_TRUNC | O_WRONLY, 0600);
    require(fd >= 0, "open for write");
    size_t len = strlen(contents);
    require(write(fd, contents, len) == (ssize_t)len, "write");
    require(close(fd) == 0, "close");
}

static void make_dir(const char *path) {
    if (mkdir(path, 0700) < 0 && errno != EEXIST)
        fail("mkdir %s: %s", path, strerror(errno));
}

static int xattr_contains(const char *list, ssize_t len, const char *name) {
    for (ssize_t i = 0; i < len; i += (ssize_t)strlen(list + i) + 1)
        if (!strcmp(list + i, name)) return 1;
    return 0;
}

static void test_xattr(void) {
    char guest[PATH_MAX], dir_guest[PATH_MAX], phys[PATH_MAX], host[PATH_MAX];
    int n = snprintf(guest, sizeof guest, "/tmp/bn-python-xattr-%ld",
                     (long)getpid());
    require(n > 0 && (size_t)n < sizeof guest, "guest path");
    n = snprintf(dir_guest, sizeof dir_guest, "/tmp/bn-python-xattr-dir-%ld",
                 (long)getpid());
    require(n > 0 && (size_t)n < sizeof dir_guest, "guest directory path");
    physical(guest, phys, sizeof phys);
    host_view(guest, host, sizeof host);

    (void)unlink(host);
    (void)unlink(phys);
    make_file(guest, "guest-xattr");

    const char *attr = "user.bionilux";
    const char *value = "value";
    require(setxattr(guest, attr, value, strlen(value), 0) == 0, "setxattr");
    require(getxattr(guest, attr, NULL, 0) == (ssize_t)strlen(value),
            "getxattr size query");
    char buf[64];
    ssize_t got = getxattr(guest, attr, buf, sizeof buf);
    require(got == (ssize_t)strlen(value) && !memcmp(buf, value, (size_t)got),
            "getxattr value");
    require(lgetxattr(guest, attr, buf, sizeof buf) == (ssize_t)strlen(value),
            "lgetxattr value");

    // Both list entry points are covered: listxattr follows the final link,
    // llistxattr does not.  P08's failing cp call is the latter.
    ssize_t list_len = listxattr(guest, NULL, 0);
    require(list_len > 0, "listxattr size query");
    char list[512];
    ssize_t list_got = listxattr(guest, list, sizeof list);
    require(list_got == list_len && xattr_contains(list, list_got, attr),
            "listxattr contents");
    ssize_t llist_len = llistxattr(guest, NULL, 0);
    require(llist_len > 0 && llist_len == list_len, "llistxattr size query");
    ssize_t llist_got = llistxattr(guest, list, sizeof list);
    require(llist_got == llist_len && xattr_contains(list, llist_got, attr),
            "llistxattr contents");

    // The physical path is already inside the rootfs, so it must show the
    // same attribute.  The host path outside the rootfs must not exist.
    require(getxattr(phys, attr, buf, sizeof buf) == (ssize_t)strlen(value),
            "physical guest path has the attribute");
    struct stat st;
    errno = 0;
    require(lstat(host, &st) == -1 && errno == ENOENT,
            "host path outside rootfs was not touched");

    // Directories are what cp -RpL lists.  Even with no attributes, the call
    // must succeed with 0 rather than falling through to a host ENOENT.
    (void)rmdir(dir_guest);
    make_dir(dir_guest);
    errno = 0;
    require(listxattr(dir_guest, NULL, 0) >= 0, "listxattr on directory");
    errno = 0;
    require(llistxattr(dir_guest, NULL, 0) >= 0, "llistxattr on directory");

    errno = 0;
    expect_fail(setxattr(guest, attr, value, strlen(value), XATTR_CREATE),
                EEXIST, "XATTR_CREATE on an existing attribute");
    require(setxattr(guest, attr, value, strlen(value), XATTR_REPLACE) == 0,
            "XATTR_REPLACE on an existing attribute");

    require(removexattr(guest, attr) == 0, "removexattr");
    errno = 0;
    expect_fail((int)getxattr(guest, attr, buf, sizeof buf), ENODATA,
                "getxattr after remove");
    errno = 0;
    expect_fail(setxattr(guest, attr, value, strlen(value), XATTR_REPLACE),
                ENODATA, "XATTR_REPLACE on an absent attribute");
    require(setxattr(guest, attr, value, strlen(value), XATTR_CREATE) == 0,
            "XATTR_CREATE on an absent attribute");
    require(removexattr(guest, attr) == 0, "remove created attribute");

    char missing[PATH_MAX];
    snprintf(missing, sizeof missing, "/tmp/bn-python-missing-%ld",
             (long)getpid());
    errno = 0;
    expect_fail((int)getxattr(missing, attr, buf, sizeof buf), ENOENT,
                "getxattr on missing guest path");

    require(unlink(guest) == 0, "unlink guest file");
    require(rmdir(dir_guest) == 0, "rmdir guest dir");
    puts("xattr: OK");
}

static const char *sem_leaf(const char *name) {
    return name + 1;
}

static void sem_cleanup(const char *name) {
    if (sem_unlink(name) < 0 && errno != ENOENT)
        fail("sem_unlink cleanup %s: %s", name, strerror(errno));
}

static unsigned long long self_start_time(void) {
    char path[64], buf[1024];
    int n = snprintf(path, sizeof path, "/proc/%ld/stat", (long)getpid());
    require(n > 0 && (size_t)n < sizeof path, "self stat path");
    FILE *stream = fopen(path, "r");
    require(stream != NULL, "open self stat");
    require(fgets(buf, sizeof buf, stream) != NULL, "read self stat");
    fclose(stream);
    char *p = strrchr(buf, ')');
    require(p != NULL, "self stat comm");
    p++;
    while (*p == ' ') p++;
    int field = 3;
    while (*p && field <= 22) {
        if (field == 22) return strtoull(p, NULL, 10);
        while (*p && *p != ' ') p++;
        while (*p == ' ') p++;
        field++;
    }
    fail("self starttime missing");
    return 0;
}

// A legal semaphore name may use the private prefix and even equal the name
// this process would otherwise choose for its temp file.  Neither the
// collision nor a later cleanup pass may delete or re-create that object.
static void test_sem_prefix_names(void) {
    unsigned long long start = self_start_time();
    char collide[NAME_MAX], dead[NAME_MAX], other[NAME_MAX];
    int n = snprintf(collide, sizeof collide,
                     "/.bn-sem-tmp-%ld-%llu-1", (long)getpid(), start);
    require(n > 0 && (size_t)n < sizeof collide, "collision sem name");
    sem_cleanup(collide);
    sem_t *c = sem_open(collide, O_CREAT | O_EXCL, 0600, 5);
    require(c != SEM_FAILED, "sem_open final name equal to temp name");

    n = snprintf(other, sizeof other, "/bn-prefix-other-%ld", (long)getpid());
    require(n > 0 && (size_t)n < sizeof other, "prefix other name");
    sem_cleanup(other);
    sem_t *o = sem_open(other, O_CREAT, 0600, 7);
    require(o != SEM_FAILED, "cleanup opener");
    require(sem_close(o) == 0, "cleanup opener close");
    require(sem_unlink(other) == 0, "cleanup opener unlink");

    int value = -1;
    require(sem_getvalue(c, &value) == 0 && value == 5,
            "collision object survived cleanup");
    require(sem_close(c) == 0, "collision close");
    require(sem_unlink(collide) == 0, "collision unlink");

    // A complete header with an unknown version is a future/foreign protocol
    // object, not a stale temp this implementation may remove.
    char foreign[PATH_MAX];
    physical("/dev/shm/.bionilux-sem/.bn-sem-tmp-999997-7-1", foreign,
             sizeof foreign);
    (void)unlink(foreign);
    struct {
        sem_t sem;
        uint64_t magic;
        uint32_t version;
        uint32_t reserved;
    } slot;
    memset(&slot, 0, sizeof slot);
    slot.magic = 0x424e53454d415054ULL;
    slot.version = 99;
    int fd = open(foreign, O_CREAT | O_EXCL | O_WRONLY, 0600);
    require(fd >= 0, "create future-version temp");
    require(write(fd, &slot, sizeof slot) == (ssize_t)sizeof slot,
            "write future-version temp");
    require(close(fd) == 0, "close future-version temp");
    o = sem_open(other, O_CREAT, 0600, 7);
    require(o != SEM_FAILED, "future-version cleanup opener");
    require(sem_close(o) == 0, "future-version cleanup close");
    require(sem_unlink(other) == 0, "future-version cleanup unlink");
    struct stat fst;
    require(stat(foreign, &fst) == 0 && fst.st_size == (off_t)sizeof slot,
            "unknown-version temp was preserved");
    require(unlink(foreign) == 0, "remove future-version temp");

    n = snprintf(dead, sizeof dead, "/.bn-sem-tmp-999999-123-1");
    require(n > 0 && (size_t)n < sizeof dead, "dead prefix name");
    sem_cleanup(dead);
    sem_t *d = sem_open(dead, O_CREAT, 0600, 5);
    require(d != SEM_FAILED, "sem_open dead-pid prefix name");
    o = sem_open(other, O_CREAT, 0600, 7);
    require(o != SEM_FAILED, "second cleanup opener");
    require(sem_close(o) == 0, "second cleanup close");
    require(sem_unlink(other) == 0, "second cleanup unlink");
    require(sem_getvalue(d, &value) == 0 && value == 5,
            "published prefix name survived cleanup");
    require(sem_close(d) == 0, "dead prefix close");
    require(sem_unlink(dead) == 0, "dead prefix unlink");
    puts("sem prefix names: OK");
}

static void test_sem(void) {
    char name[NAME_MAX];
    int n = snprintf(name, sizeof name, "/bn-python-sem-%ld", (long)getpid());
    require(n > 0 && (size_t)n < sizeof name, "sem name");
    sem_cleanup(name);

    errno = 0;
    require(sem_open("bad", O_CREAT, 0600, 1) == SEM_FAILED && errno == EINVAL,
            "sem_open rejects a name without a leading slash");
    errno = 0;
    require(sem_open("/bad/name", O_CREAT, 0600, 1) == SEM_FAILED &&
                errno == EINVAL,
            "sem_open rejects a second slash");
    errno = 0;
    require(sem_open("/.", O_CREAT, 0600, 1) == SEM_FAILED &&
                errno == EINVAL,
            "sem_open rejects dot name");
    errno = 0;
    require(sem_open("/..", O_CREAT, 0600, 1) == SEM_FAILED &&
                errno == EINVAL,
            "sem_open rejects dotdot name");
    errno = 0;
    require(sem_open(name, 0) == SEM_FAILED && errno == ENOENT,
            "sem_open without O_CREAT on a missing name");

    // A caller that creates the object initialises it.  A caller that merely
    // observes O_CREAT on an existing object must not overwrite the value.
    sem_t *s1 = sem_open(name, O_CREAT, 0600, 3);
    require(s1 != SEM_FAILED, "sem_open create");
    sem_t *s2 = sem_open(name, O_CREAT, 0600, 99);
    require(s2 == s1, "repeated sem_open returns the same pointer");
    int value = -1;
    require(sem_getvalue(s2, &value) == 0 && value == 3,
            "existing semaphore keeps its creation value");

    // glibc ignores an out-of-range value for an existing O_CREAT object
    // (the value is only used by the creating call), but validates it first
    // when O_EXCL is present.
    sem_t *extra = sem_open(name, O_CREAT, 0600,
                            (unsigned int)SEM_VALUE_MAX + 1u);
    require(extra == s1, "existing O_CREAT ignores an unused large value");
    require(sem_close(extra) == 0, "close unused large-value reference");
    errno = 0;
    sem_t *big_excl =
        sem_open(name, O_CREAT | O_EXCL, 0600, (unsigned int)SEM_VALUE_MAX + 1u);
    require(big_excl == SEM_FAILED && errno == EINVAL,
            "O_EXCL validates the value before reporting EEXIST");

    // A valid cached hit under O_EXCL must not return the cached pointer.
    sem_t *excl = sem_open(name, O_CREAT | O_EXCL, 0600, 1);
    require(excl == SEM_FAILED && errno == EEXIST,
            "O_EXCL reports EEXIST");

    // Reference counting: one close leaves the other reference usable.
    require(sem_close(s1) == 0, "first sem_close");
    require(sem_getvalue(s2, &value) == 0 && value == 3,
            "semaphore survives the first close");

    pid_t pid = fork();
    require(pid >= 0, "fork for sem cross-process test");
    if (pid == 0) {
        sem_t *child = sem_open(name, 0);
        if (child == SEM_FAILED) _exit(2);
        if (sem_post(child) != 0) _exit(3);
        (void)sem_close(child);
        _exit(0);
    }
    int status = 0;
    require(waitpid(pid, &status, 0) == pid, "waitpid sem child");
    require(WIFEXITED(status) && WEXITSTATUS(status) == 0,
            "sem child exited cleanly");
    require(sem_wait(s2) == 0, "parent waits for child post");

    require(sem_close(s2) == 0, "last sem_close");
    require(sem_unlink(name) == 0, "sem_unlink");
    errno = 0;
    expect_fail(sem_unlink(name), ENOENT, "second sem_unlink");
    errno = 0;
    require(sem_open(name, 0) == SEM_FAILED && errno == ENOENT,
            "open after unlink reports ENOENT");

    // sem_close must not unmap an arbitrary pointer.  The registry lookup is
    // the only path to munmap.
    sem_t unknown;
    memset(&unknown, 0, sizeof unknown);
    errno = 0;
    expect_fail(sem_close(&unknown), EINVAL, "sem_close on an unknown pointer");

    // An empty pre-existing file is corrupt.  It must not be adopted and
    // initialised with this caller's value (the ownership race).
    char dir[PATH_MAX], path[PATH_MAX];
    physical("/dev/shm/.bionilux-sem", dir, sizeof dir);
    if (mkdir(dir, 0777) < 0 && errno != EEXIST)
        fail("mkdir sem dir: %s", strerror(errno));
    n = snprintf(path, sizeof path, "%s/%s", dir, sem_leaf(name));
    require(n > 0 && (size_t)n < sizeof path, "sem physical path");
    (void)unlink(path);
    int fd = open(path, O_CREAT | O_EXCL | O_WRONLY, 0600);
    require(fd >= 0, "create empty sem file");
    require(close(fd) == 0, "close empty sem file");
    errno = 0;
    require(sem_open(name, O_CREAT, 0600, 123) == SEM_FAILED &&
                errno == EINVAL,
            "empty existing sem file is rejected");
    struct stat st;
    require(stat(path, &st) == 0 && st.st_size == 0,
            "rejected empty sem file was not initialised");
    require(unlink(path) == 0, "remove empty sem file");

    // sem_init failure must clean up a file created by this call.
    errno = 0;
    require(sem_open(name, O_CREAT, 0600, (unsigned int)SEM_VALUE_MAX + 1u) ==
                SEM_FAILED &&
                errno == EINVAL,
            "sem_init range failure is reported");
    errno = 0;
    require(sem_open(name, 0) == SEM_FAILED && errno == ENOENT,
            "failed creation left no semaphore");

    // Unlink detaches the name from open handles.  A later create is a new
    // semaphore with a new value and a different address.
    s1 = sem_open(name, O_CREAT, 0600, 5);
    require(s1 != SEM_FAILED, "sem_open before unlink");
    require(sem_unlink(name) == 0, "sem_unlink with an open handle");
    s2 = sem_open(name, O_CREAT, 0600, 7);
    require(s2 != SEM_FAILED, "sem_open after unlink");
    require(s2 != s1, "post-unlink sem_open has a new identity");
    require(sem_getvalue(s1, &value) == 0 && value == 5,
            "old handle keeps its value");
    require(sem_getvalue(s2, &value) == 0 && value == 7,
            "new handle has the new value");
    require(sem_close(s1) == 0, "close old handle");
    require(sem_close(s2) == 0, "close new handle");
    sem_cleanup(name);

    // The temp file is created with the caller's mode and umask; rename must
    // not change the published mode.
    char mode_name[NAME_MAX], mode_path[PATH_MAX];
    n = snprintf(mode_name, sizeof mode_name, "/bn-python-mode-%ld",
                 (long)getpid());
    require(n > 0 && (size_t)n < sizeof mode_name, "mode sem name");
    sem_cleanup(mode_name);
    mode_t old_mask = umask(0077);
    sem_t *mode_sem = sem_open(mode_name, O_CREAT, 0666, 1);
    mode_t current_mask = umask(old_mask);
    require(mode_sem != SEM_FAILED, "umask sem_open");
    require(current_mask == 0077, "restore umask");
    n = snprintf(mode_path, sizeof mode_path, "%s/%s", dir,
                 sem_leaf(mode_name));
    require(n > 0 && (size_t)n < sizeof mode_path, "mode sem path");
    require(stat(mode_path, &st) == 0 &&
                (st.st_mode & 0777) == 0600,
            "published semaphore honors mode and umask");
    require(sem_close(mode_sem) == 0, "close umask sem");
    sem_cleanup(mode_name);

    puts("sem: OK");
}

struct thread_arg {
    const char *name;
    sem_t *expected;
    sem_t *got;
};

static void *sem_thread_open(void *opaque) {
    struct thread_arg *arg = (struct thread_arg *)opaque;
    arg->got = sem_open(arg->name, 0);
    if (arg->got != SEM_FAILED) (void)sem_close(arg->got);
    return NULL;
}

static void test_sem_threads(void) {
    char name[NAME_MAX];
    int n = snprintf(name, sizeof name, "/bn-python-thread-%ld", (long)getpid());
    require(n > 0 && (size_t)n < sizeof name, "thread sem name");
    sem_cleanup(name);

    sem_t *base = sem_open(name, O_CREAT, 0600, 1);
    require(base != SEM_FAILED, "thread base sem_open");

    enum { THREADS = 8 };
    pthread_t ids[THREADS];
    struct thread_arg args[THREADS];
    for (int i = 0; i < THREADS; i++) {
        args[i].name = name;
        args[i].expected = base;
        args[i].got = SEM_FAILED;
        require(pthread_create(&ids[i], NULL, sem_thread_open, &args[i]) == 0,
                "pthread_create");
    }
    for (int i = 0; i < THREADS; i++)
        require(pthread_join(ids[i], NULL) == 0, "pthread_join");
    for (int i = 0; i < THREADS; i++)
        require(args[i].got == base,
                "concurrent sem_open returns the registry pointer");

    require(sem_close(base) == 0, "close thread base");
    sem_cleanup(name);
    puts("sem threads: OK");
}

static volatile sig_atomic_t churn_stop;

static void *sem_churn(void *opaque) {
    const char *name = (const char *)opaque;
    while (!churn_stop) {
        sem_t *sem = sem_open(name, O_CREAT, 0600, 1);
        if (sem != SEM_FAILED) (void)sem_close(sem);
    }
    return NULL;
}

static void test_sem_fork(void) {
    char name[NAME_MAX];
    int n = snprintf(name, sizeof name, "/bn-python-fork-%ld", (long)getpid());
    require(n > 0 && (size_t)n < sizeof name, "fork sem name");
    sem_cleanup(name);

    sem_t *base = sem_open(name, O_CREAT, 0600, 1);
    require(base != SEM_FAILED, "fork base sem_open");
    churn_stop = 0;
    pthread_t thread;
    require(pthread_create(&thread, NULL, sem_churn, name) == 0,
            "start churn thread");

    pid_t pid = fork();
    require(pid >= 0, "fork during sem_open churn");
    if (pid == 0) {
        alarm(5);
        sem_t *child = sem_open(name, O_CREAT, 0600, 1);
        if (child == SEM_FAILED) _exit(2);
        (void)sem_close(child);
        _exit(0);
    }

    int status = 0;
    require(waitpid(pid, &status, 0) == pid, "waitpid fork sem child");
    churn_stop = 1;
    require(pthread_join(thread, NULL) == 0, "join churn thread");
    require(WIFEXITED(status) && WEXITSTATUS(status) == 0,
            "fork child used the registry without deadlocking");
    require(sem_close(base) == 0, "close fork base");
    sem_cleanup(name);
    puts("sem fork: OK");
}

// The mapping inherited across fork must be the same shared futex object.
// This is the primitive Python's SemLock uses when its child calls acquire().
static void test_sem_inherit(void) {
    char name[NAME_MAX];
    int n = snprintf(name, sizeof name, "/bn-python-inherit-%ld", (long)getpid());
    require(n > 0 && (size_t)n < sizeof name, "inherit sem name");
    sem_cleanup(name);

    sem_t *sem = sem_open(name, O_CREAT, 0600, 0);
    require(sem != SEM_FAILED, "inherit sem_open");
    pid_t pid = fork();
    require(pid >= 0, "fork inherited sem");
    if (pid == 0) {
        alarm(5);
        if (sem_wait(sem) != 0) _exit(2);
        _exit(0);
    }
    require(sem_post(sem) == 0, "parent posts inherited sem");
    int status = 0;
    require(waitpid(pid, &status, 0) == pid, "waitpid inherited sem");
    require(WIFEXITED(status) && WEXITSTATUS(status) == 0,
            "child woke on the inherited shared semaphore");
    require(sem_close(sem) == 0, "close inherited sem");
    sem_cleanup(name);
    puts("sem inherit: OK");
}

static void test_shm(void) {
    char name[NAME_MAX];
    int n = snprintf(name, sizeof name, "/bn-python-shm-%ld", (long)getpid());
    require(n > 0 && (size_t)n < sizeof name, "shm name");
    if (shm_unlink(name) < 0 && errno != ENOENT)
        fail("shm_unlink cleanup: %s", strerror(errno));

    errno = 0;
    expect_fail(shm_open("bad", O_CREAT | O_RDWR, 0600), EINVAL,
                "shm_open rejects a name without a leading slash");
    errno = 0;
    expect_fail(shm_open("/bad/name", O_CREAT | O_RDWR, 0600), EINVAL,
                "shm_open rejects a second slash");
    errno = 0;
    expect_fail(shm_open("/.", O_CREAT | O_RDWR, 0600), EINVAL,
                "shm_open rejects dot name");
    errno = 0;
    expect_fail(shm_open("/..", O_CREAT | O_RDWR, 0600), EINVAL,
                "shm_open rejects dotdot name");
    errno = 0;
    expect_fail(shm_open(name, O_RDWR, 0), ENOENT,
                "shm_open missing object");

    int fd = shm_open(name, O_CREAT | O_EXCL | O_RDWR, 0600);
    require(fd >= 0, "shm_open create");
    require(ftruncate(fd, 4096) == 0, "ftruncate shm");
    char *map = mmap(NULL, 4096, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    require(map != MAP_FAILED, "mmap shm");
    strcpy(map, "parent");
    errno = 0;
    expect_fail(shm_open(name, O_CREAT | O_EXCL | O_RDWR, 0600), EEXIST,
                "shm_open O_EXCL existing");

    pid_t pid = fork();
    require(pid >= 0, "fork for shm test");
    if (pid == 0) {
        int child_fd = shm_open(name, O_RDWR, 0);
        if (child_fd < 0) _exit(2);
        char *child_map =
            mmap(NULL, 4096, PROT_READ | PROT_WRITE, MAP_SHARED, child_fd, 0);
        if (child_map == MAP_FAILED) _exit(3);
        if (strcmp(child_map, "parent")) _exit(4);
        strcpy(child_map, "child");
        (void)munmap(child_map, 4096);
        (void)close(child_fd);
        _exit(0);
    }
    int status = 0;
    require(waitpid(pid, &status, 0) == pid, "waitpid shm child");
    require(WIFEXITED(status) && WEXITSTATUS(status) == 0,
            "shm child observed and updated shared memory");
    require(!strcmp(map, "child"), "parent sees child's shared write");

    char phys[PATH_MAX], guest[PATH_MAX];
    snprintf(guest, sizeof guest, "/dev/shm/%s", name + 1);
    physical(guest, phys, sizeof phys);
    struct stat st;
    require(stat(phys, &st) == 0 && S_ISREG(st.st_mode),
            "shm object lives in guest /dev/shm");

    require(munmap(map, 4096) == 0, "munmap shm");
    require(close(fd) == 0, "close shm");
    require(shm_unlink(name) == 0, "shm_unlink");
    errno = 0;
    expect_fail(shm_unlink(name), ENOENT, "second shm_unlink");
    errno = 0;
    expect_fail(shm_open(name, O_RDWR, 0), ENOENT,
                "shm_open after unlink");
    puts("shm: OK");
}

static void test_native(void) {
    char name[NAME_MAX];
    int n = snprintf(name, sizeof name, "/bn-native-sem-%ld", (long)getpid());
    require(n > 0 && (size_t)n < sizeof name, "native sem name");
    (void)sem_unlink(name);
    sem_t *sem = sem_open(name, O_CREAT | O_EXCL, 0600, 2);
    require(sem != SEM_FAILED, "native sem_open");
    int value = 0;
    require(sem_getvalue(sem, &value) == 0 && value == 2,
            "native sem_getvalue");
    require(sem_close(sem) == 0, "native sem_close");
    require(sem_unlink(name) == 0, "native sem_unlink");

    n = snprintf(name, sizeof name, "/bn-native-shm-%ld", (long)getpid());
    require(n > 0 && (size_t)n < sizeof name, "native shm name");
    (void)shm_unlink(name);
    int fd = shm_open(name, O_CREAT | O_EXCL | O_RDWR, 0600);
    require(fd >= 0, "native shm_open");
    require(close(fd) == 0, "native shm close");
    require(shm_unlink(name) == 0, "native shm_unlink");
    puts("native delegation: OK");
}

// The exact call at the end of the failing cp trace: llistxattr(path, NULL, 0)
// on a directory that exists only inside the guest.  A host fallback reports
// ENOENT; a successful mapping returns a non-negative size (often 0).
static void test_p08(void) {
    const char *path = getenv("BN_P08_PATH");
    if (!path || !*path) fail("BN_P08_PATH is not set");
    errno = 0;
    ssize_t len = llistxattr(path, NULL, 0);
    require(len >= 0, "llistxattr on guest directory");
    printf("p08 llistxattr: OK (%zd bytes)\n", len);
}

// Used by the SIGKILL recovery test.  The creator stays in sem_init() until
// the shell kills it; the successor must create the final name from scratch.
static void test_sem_create(const char *name, unsigned int value) {
    sem_t *sem = sem_open(name, O_CREAT, 0600, value);
    require(sem != SEM_FAILED, "sem-create sem_open");
    int got = -1;
    require(sem_getvalue(sem, &got) == 0 && got == (int)value,
            "sem-create value");
    printf("sem-create: value=%d\n", got);
    require(sem_close(sem) == 0, "sem-create sem_close");
}

static void test_sem_check(const char *name, unsigned int expected) {
    sem_t *sem = sem_open(name, O_CREAT, 0600, 7);
    require(sem != SEM_FAILED, "sem-check sem_open after creator death");
    int got = -1;
    require(sem_getvalue(sem, &got) == 0 && got == (int)expected,
            "sem-check successor value");
    printf("sem-check: value=%d\n", got);
    require(sem_close(sem) == 0, "sem-check sem_close");
    require(sem_unlink(name) == 0, "sem-check sem_unlink");
}

// Populate the parent's cached start-time token, then let a child create a
// temp file.  The child must encode its own pid/starttime pair.  The shell
// driver kills the paused child and inspects the name before recovery.
static void test_sem_fork_create(const char *name) {
    char parent_name[NAME_MAX];
    int n = snprintf(parent_name, sizeof parent_name,
                     "/bn-python-fork-parent-%ld", (long)getpid());
    require(n > 0 && (size_t)n < sizeof parent_name, "fork parent name");
    sem_cleanup(parent_name);
    sem_t *parent = sem_open(parent_name, O_CREAT, 0600, 1);
    require(parent != SEM_FAILED, "fork parent sem_open");
    require(sem_close(parent) == 0, "fork parent sem_close");
    sem_cleanup(parent_name);

    pid_t pid = fork();
    require(pid >= 0, "fork for creator identity");
    if (pid == 0) {
        alarm(10);
        sem_t *child = sem_open(name, O_CREAT, 0600, 0x5a5a);
        if (child == SEM_FAILED) _exit(2);
        int got = -1;
        if (sem_getvalue(child, &got) != 0 || got != 0x5a5a) _exit(3);
        (void)sem_close(child);
        _exit(0);
    }
    int status = 0;
    require(waitpid(pid, &status, 0) == pid, "waitpid fork creator");
    if (WIFEXITED(status) && WEXITSTATUS(status) != 0)
        fail("fork creator child exited %d", WEXITSTATUS(status));
    if (WIFEXITED(status) && WEXITSTATUS(status) == 0)
        (void)sem_unlink(name);
    puts("sem fork creator: OK");
}

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr,
                "usage: %s xattr|sem|sem-threads|sem-fork|sem-inherit|shm|"
                "native|p08|sem-create NAME VALUE|sem-check NAME VALUE|"
                "sem-fork-create NAME|sem-prefix\n",
                argv[0]);
        return 2;
    }
    if (!strcmp(argv[1], "xattr")) test_xattr();
    else if (!strcmp(argv[1], "sem")) test_sem();
    else if (!strcmp(argv[1], "sem-threads")) test_sem_threads();
    else if (!strcmp(argv[1], "sem-fork")) test_sem_fork();
    else if (!strcmp(argv[1], "sem-inherit")) test_sem_inherit();
    else if (!strcmp(argv[1], "shm")) test_shm();
    else if (!strcmp(argv[1], "native")) test_native();
    else if (!strcmp(argv[1], "p08")) test_p08();
    else if (!strcmp(argv[1], "sem-create") && argc == 4)
        test_sem_create(argv[2], (unsigned int)strtoul(argv[3], NULL, 0));
    else if (!strcmp(argv[1], "sem-check") && argc == 4)
        test_sem_check(argv[2], (unsigned int)strtoul(argv[3], NULL, 0));
    else if (!strcmp(argv[1], "sem-fork-create") && argc == 3)
        test_sem_fork_create(argv[2]);
    else if (!strcmp(argv[1], "sem-prefix"))
        test_sem_prefix_names();
    else {
        fprintf(stderr, "unknown mode: %s\n", argv[1]);
        return 2;
    }
    return 0;
}
