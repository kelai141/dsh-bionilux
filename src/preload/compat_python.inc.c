// Python compatibility hooks: extended attributes and POSIX IPC names.
//
// This file is included by hooks.c after the shared path-mapping helpers, so
// it deliberately uses bn_resolve() and REAL() instead of carrying a second
// copy of the rootfs rules.  It is a separate translation-unit fragment only
// to keep the two compatibility areas reviewable in isolation.
//
// Two different kinds of names appear here:
//
//   * xattr path arguments are ordinary filesystem paths.  They follow every
//     rootfs rule, including absolute-path mapping and ".." clamping.
//   * sem_open()/shm_open() names are POSIX IPC names, not filesystem paths.
//     glibc turns them into /dev/shm/... itself, after the preload boundary,
//     so a path hook cannot see that internal open.  The wrappers below put
//     the objects in the guest's /dev/shm explicitly.  A name keeps its
//     meaning across processes using the same rootfs, which is the property
//     Python's multiprocessing relies on.

#ifndef BIONILUX_COMPAT_PYTHON_INC_C
#define BIONILUX_COMPAT_PYTHON_INC_C

#include <semaphore.h>
#include <sys/file.h>
#include <sys/mman.h>
#include <sys/xattr.h>

// ── extended attributes ─────────────────────────────────────────────
//
// Every path-taking xattr entry point needs the same rewrite.  The kernel
// keeps errno from the real call, so a missing guest object stays ENOENT and
// an absent attribute stays ENODATA; neither is converted into success.  The
// fd-taking forms operate on an already-mapped descriptor and need no hook.

#define BN_XATTR_GET(fn_name)                                                 \
    ssize_t fn_name(const char *path, const char *name, void *value,           \
                    size_t size) {                                            \
        typedef ssize_t (*fn_t)(const char *, const char *, void *, size_t);  \
        static _Thread_local fn_t real;                                       \
        REAL(real, #fn_name);                                                 \
        if (!real) { errno = ENOSYS; return -1; }                             \
        char buf[PATH_MAX];                                                   \
        return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), name, value, \
                    size);                                                    \
    }

#define BN_XATTR_SET(fn_name)                                                 \
    int fn_name(const char *path, const char *name, const void *value,        \
                size_t size, int flags) {                                     \
        typedef int (*fn_t)(const char *, const char *, const void *,         \
                            size_t, int);                                     \
        static _Thread_local fn_t real;                                       \
        REAL(real, #fn_name);                                                 \
        if (!real) { errno = ENOSYS; return -1; }                             \
        char buf[PATH_MAX];                                                   \
        return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), name, value, \
                    size, flags);                                             \
    }

#define BN_XATTR_REMOVE(fn_name)                                              \
    int fn_name(const char *path, const char *name) {                         \
        typedef int (*fn_t)(const char *, const char *);                      \
        static _Thread_local fn_t real;                                       \
        REAL(real, #fn_name);                                                 \
        if (!real) { errno = ENOSYS; return -1; }                             \
        char buf[PATH_MAX];                                                   \
        return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), name);       \
    }

#define BN_XATTR_LIST(fn_name)                                                \
    ssize_t fn_name(const char *path, char *list, size_t size) {              \
        typedef ssize_t (*fn_t)(const char *, char *, size_t);                \
        static _Thread_local fn_t real;                                       \
        REAL(real, #fn_name);                                                 \
        if (!real) { errno = ENOSYS; return -1; }                             \
        char buf[PATH_MAX];                                                   \
        return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), list, size);  \
    }

BN_XATTR_GET(getxattr)
BN_XATTR_GET(lgetxattr)
BN_XATTR_SET(setxattr)
BN_XATTR_SET(lsetxattr)
BN_XATTR_REMOVE(removexattr)
BN_XATTR_REMOVE(lremovexattr)
BN_XATTR_LIST(listxattr)
BN_XATTR_LIST(llistxattr)

#undef BN_XATTR_GET
#undef BN_XATTR_SET
#undef BN_XATTR_REMOVE
#undef BN_XATTR_LIST

// ── POSIX IPC name validation ───────────────────────────────────────

// POSIX requires "/name": one leading slash and no further slash.  glibc
// reports EINVAL for malformed names and ENAMETOOLONG when the component
// cannot fit in a directory entry.  "." and ".." are rejected explicitly:
// treating them as ordinary components would let shm_open("/.") resolve to
// the /dev/shm directory (or its parent) instead of a shared-memory object.
static int bn_py_ipc_name(const char *name) {
    if (!name || name[0] != '/' || name[1] == '\0') {
        errno = EINVAL;
        return -1;
    }
    if (strchr(name + 1, '/')) {
        errno = EINVAL;
        return -1;
    }
    const char *leaf = name + 1;
    if (!strcmp(leaf, ".") || !strcmp(leaf, "..")) {
        errno = EINVAL;
        return -1;
    }
    if (strlen(leaf) > NAME_MAX) {
        errno = ENAMETOOLONG;
        return -1;
    }
    return 0;
}

// The IPC objects deliberately live in the guest's /dev/shm.  That directory
// is the one host-virtual exception in the path rules, so this is the point
// where the guest's writable shm directory differs from a host that may not
// even have /dev/shm (notably Android).  The result is a physical path, not a
// guest path: we are about to hand it to the real open().
static int bn_py_ipc_path(const char *guest, char *buf, size_t size) {
    const char *root = bn_rootfs();
    char norm[PATH_MAX];
    bn_normalize(guest, norm, sizeof norm);
    int written = snprintf(buf, size, "%s%s", root ? root : "", norm);
    if (written < 0 || (size_t)written >= size) {
        errno = ENAMETOOLONG;
        return -1;
    }
    return 0;
}

static int bn_py_shm_path(const char *name, char *buf, size_t size) {
    char guest[PATH_MAX];
    int written = snprintf(guest, sizeof guest, "/dev/shm/%s", name + 1);
    if (written < 0 || (size_t)written >= sizeof guest) {
        errno = ENAMETOOLONG;
        return -1;
    }
    return bn_py_ipc_path(guest, buf, size);
}

static int bn_py_sem_path(const char *name, char *buf, size_t size) {
    char guest[PATH_MAX];
    int written = snprintf(guest, sizeof guest, "/dev/shm/.bionilux-sem/%s",
                           name + 1);
    if (written < 0 || (size_t)written >= sizeof guest) {
        errno = ENAMETOOLONG;
        return -1;
    }
    return bn_py_ipc_path(guest, buf, size);
}

static int bn_py_open_raw(const char *path, int flags, mode_t mode) {
    typedef int (*open_fn)(const char *, int, ...);
    static _Thread_local open_fn real;
    REAL(real, "open64");
    if (!real) REAL(real, "open");
    if (!real) { errno = ENOSYS; return -1; }
    return real(path, flags, mode);
}

static int bn_py_close_raw(int fd) {
    typedef int (*close_fn)(int);
    static _Thread_local close_fn real;
    REAL(real, "close");
    if (!real) { errno = ENOSYS; return -1; }
    return real(fd);
}

static int bn_py_unlink_raw(const char *path) {
    typedef int (*unlink_fn)(const char *);
    static _Thread_local unlink_fn real;
    REAL(real, "unlink");
    if (!real) { errno = ENOSYS; return -1; }
    return real(path);
}

static int bn_py_openat_raw(int dirfd, const char *path, int flags,
                            mode_t mode) {
    typedef int (*openat_fn)(int, const char *, int, ...);
    static _Thread_local openat_fn real;
    REAL(real, "openat64");
    if (!real) REAL(real, "openat");
    if (!real) { errno = ENOSYS; return -1; }
    return real(dirfd, path, flags, mode);
}

static int bn_py_fstat_raw(int fd, struct stat *st) {
    typedef int (*fstat_fn)(int, struct stat *);
    static _Thread_local fstat_fn real;
    REAL(real, "fstat");
    if (!real) { errno = ENOSYS; return -1; }
    return real(fd, st);
}

static int bn_py_fstatat_raw(int dirfd, const char *path, struct stat *st,
                             int flags) {
    typedef int (*fstatat_fn)(int, const char *, struct stat *, int);
    static _Thread_local fstatat_fn real;
    REAL(real, "fstatat");
    if (!real) { errno = ENOSYS; return -1; }
    return real(dirfd, path, st, flags);
}

static int bn_py_unlinkat_raw(int dirfd, const char *path, int flags) {
    typedef int (*unlinkat_fn)(int, const char *, int);
    static _Thread_local unlinkat_fn real;
    REAL(real, "unlinkat");
    if (!real) { errno = ENOSYS; return -1; }
    return real(dirfd, path, flags);
}

// Ownership must be the real effective uid, not the guest's virtual root.
// /dev/shm and its protocol directory are normally root-owned and mode 0777,
// while the creator writes as the app uid, so the directory owner is not a
// usable ownership reference.
static uid_t bn_py_geteuid_raw(void) {
    typedef uid_t (*fn_t)(void);
    static _Thread_local fn_t real;
    REAL(real, "geteuid");
    if (!real) return (uid_t)-1;
    return real();
}

static int bn_py_lstat_raw(const char *path, struct stat *st) {
    typedef int (*lstat_fn)(const char *, struct stat *);
    static _Thread_local lstat_fn real;
    REAL(real, "lstat");
    if (!real) { errno = ENOSYS; return -1; }
    return real(path, st);
}

// ── POSIX shared memory ─────────────────────────────────────────────

int shm_open(const char *name, int oflag, mode_t mode) {
    typedef int (*fn_t)(const char *, int, mode_t);
    static _Thread_local fn_t real;
    REAL(real, "shm_open");

    // Without a rootfs the host is the guest; keep the real symbol so the
    // host's own /dev/shm semantics are untouched.
    if (!bn_rootfs()) {
        if (!real) { errno = ENOSYS; return -1; }
        return real(name, oflag, mode);
    }

    if (bn_py_ipc_name(name) < 0) return -1;
    char path[PATH_MAX];
    if (bn_py_shm_path(name, path, sizeof path) < 0) return -1;

    int fd = bn_py_open_raw(path, oflag | O_NOFOLLOW | O_CLOEXEC, mode);
    if (fd < 0) return -1;

    typedef int (*fstat_fn)(int, struct stat *);
    static _Thread_local fstat_fn real_fstat;
    REAL(real_fstat, "fstat");
    if (!real_fstat) {
        bn_py_close_raw(fd);
        errno = ENOSYS;
        return -1;
    }
    struct stat st;
    if (real_fstat(fd, &st) < 0) {
        int saved = errno;
        bn_py_close_raw(fd);
        errno = saved;
        return -1;
    }
    if (!S_ISREG(st.st_mode)) {
        bn_py_close_raw(fd);
        errno = EINVAL;
        return -1;
    }
    return fd;
}

int shm_unlink(const char *name) {
    typedef int (*fn_t)(const char *);
    static _Thread_local fn_t real;
    REAL(real, "shm_unlink");
    if (!bn_rootfs()) {
        if (!real) { errno = ENOSYS; return -1; }
        return real(name);
    }
    if (bn_py_ipc_name(name) < 0) return -1;
    char path[PATH_MAX];
    if (bn_py_shm_path(name, path, sizeof path) < 0) return -1;
    return bn_py_unlink_raw(path);
}

// ── POSIX named semaphores ──────────────────────────────────────────
//
// glibc's sem_open() hardcodes /dev/shm internally, so a path interposer
// cannot redirect it.  The implementation below rebuilds the object in the
// guest's /dev/shm with a MAP_SHARED file and sem_init(pshared=1), which keeps
// the observable contract: processes using the same name and rootfs share one
// futex-backed semaphore, and sem_unlink() removes the name for future
// openers.
//
// Ownership matters.  A caller doing O_CREAT without O_EXCL must not let a
// second process initialise the file with the second caller's value.  A
// directory lock serialises creation; whoever holds the lock and creates the
// file is the only process allowed to initialise it.  A file that already
// exists but is empty is corrupt, not an invitation to initialise it with
// another process's value.  Initialisation failure unlinks only a file this
// call created while it still holds that lock.
//
// The in-process registry gives repeated sem_open(name) calls the same
// sem_t*, as POSIX requires.  sem_close() only unmaps a pointer found there,
// and the mutex is reset across fork with pthread_atfork so a child cannot
// inherit a permanently locked registry.

// The temporary file carries a distinct magic while it is being initialised.
// Cleanup can therefore distinguish an abandoned in-progress object from an
// unrelated regular file that merely happens to use the same name prefix.
#define BN_PY_SEM_MAGIC UINT64_C(0x424e53454d415048) // "BNSEMAPH"
#define BN_PY_SEM_TEMP_MAGIC UINT64_C(0x424e53454d415054) // "BNSEMAPT"
#define BN_PY_SEM_VERSION 1u
#define BN_PY_SEM_TEMP_PREFIX ".bn-sem-tmp-"
#define BN_PY_SEM_LEGACY_GRACE 60

#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE 1
#endif

struct bn_py_sem_slot {
    sem_t sem;
    uint64_t magic;
    uint32_t version;
    // New creators store a hash of the final basename here.  It stays inside
    // the existing 48-byte ABI; files from the old implementation have zero.
    uint32_t reserved;
};

_Static_assert(offsetof(struct bn_py_sem_slot, reserved) +
                   sizeof(uint32_t) == sizeof(struct bn_py_sem_slot),
               "semaphore name hash must stay inside the existing slot ABI");

static uint32_t bn_py_sem_name_hash(const char *name) {
    uint32_t hash = UINT32_C(2166136261);
    for (; name && *name; name++) {
        hash ^= (unsigned char)*name;
        hash *= UINT32_C(16777619);
    }
    return hash ? hash : 1u;
}

struct bn_py_sem_entry {
    struct bn_py_sem_entry *next;
    sem_t *sem;
    char *name;
    dev_t dev;
    ino_t ino;
    unsigned refs;
};

static pthread_mutex_t bn_py_sem_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_once_t bn_py_sem_once = PTHREAD_ONCE_INIT;
static struct bn_py_sem_entry *bn_py_sem_entries;

// /proc/<pid>/stat field 22 is the process start time in clock ticks since
// boot.  It is stable for the process lifetime and changes when a pid is
// reused, unlike the pid alone.  Return 0 on success, 1 when the process does
// not exist, and -1 when the identity cannot be determined.
static int bn_py_sem_proc_identity(pid_t pid, unsigned long long *start,
                                   char *state) {
    char path[64];
    int n = snprintf(path, sizeof path, "/proc/%ld/stat", (long)pid);
    if (n <= 0 || (size_t)n >= sizeof path) return -1;
    int fd = bn_py_open_raw(path, O_RDONLY | O_CLOEXEC, 0);
    if (fd < 0) return errno == ENOENT ? 1 : -1;
    char buf[1024];
    ssize_t got;
    do {
        got = read(fd, buf, sizeof buf - 1);
    } while (got < 0 && errno == EINTR);
    (void)bn_py_close_raw(fd);
    if (got <= 0) return -1;
    buf[got] = 0;

    // comm may contain spaces and ')'.  Fields after the final ')' are
    // space-separated: state is field 3 and starttime is field 22.
    char *p = strrchr(buf, ')');
    if (!p) return -1;
    p++;
    while (*p == ' ') p++;
    int field = 3;
    while (*p && field <= 22) {
        if (field == 3 && state) *state = *p;
        if (field == 22) {
            char *end = NULL;
            errno = 0;
            unsigned long long value = strtoull(p, &end, 10);
            if (end == p || errno == ERANGE) return -1;
            *start = value;
            return 0;
        }
        while (*p && *p != ' ') p++;
        while (*p == ' ') p++;
        field++;
    }
    return -1;
}

// The cache is keyed by pid because a forked child inherits these statics but
// must not inherit the parent's starttime.  Publish the start token before the
// pid with release/acquire ordering so a concurrent caller cannot observe a
// matching pid paired with an older token.
static long bn_py_sem_identity_pid;
static unsigned long long bn_py_sem_identity_start;

static unsigned long long bn_py_sem_self_identity(void) {
    long pid = (long)getpid();
    if (__atomic_load_n(&bn_py_sem_identity_pid, __ATOMIC_ACQUIRE) == pid)
        return __atomic_load_n(&bn_py_sem_identity_start, __ATOMIC_RELAXED);

    char state = 0;
    unsigned long long start = 0;
    if (bn_py_sem_proc_identity((pid_t)pid, &start, &state) != 0 || !start)
        return 0;
    __atomic_store_n(&bn_py_sem_identity_start, start, __ATOMIC_RELAXED);
    __atomic_store_n(&bn_py_sem_identity_pid, pid, __ATOMIC_RELEASE);
    return start;
}

static void bn_py_sem_atfork_prepare(void) {
    (void)pthread_mutex_lock(&bn_py_sem_mutex);
}

static void bn_py_sem_atfork_parent(void) {
    (void)pthread_mutex_unlock(&bn_py_sem_mutex);
}

static void bn_py_sem_atfork_child(void) {
    (void)pthread_mutex_unlock(&bn_py_sem_mutex);
}

static void bn_py_sem_register_atfork(void) {
    (void)pthread_atfork(bn_py_sem_atfork_prepare, bn_py_sem_atfork_parent,
                         bn_py_sem_atfork_child);
}

__attribute__((constructor)) static void bn_py_sem_module_init(void) {
    (void)pthread_once(&bn_py_sem_once, bn_py_sem_register_atfork);
}

static void bn_py_sem_registry_init(void) {
    (void)pthread_once(&bn_py_sem_once, bn_py_sem_register_atfork);
}

// Lock the semaphore directory itself.  A directory inode is a stable,
// visible-to-all-processes lock and avoids reserving yet another child name.
static int bn_py_sem_lock_dir(int create_dir, int *fd_out) {
    char dir[PATH_MAX];
    if (bn_py_ipc_path("/dev/shm/.bionilux-sem", dir, sizeof dir) < 0)
        return -1;

    if (create_dir) {
        typedef int (*mkdir_fn)(const char *, mode_t);
        static _Thread_local mkdir_fn real_mkdir;
        REAL(real_mkdir, "mkdir");
        if (!real_mkdir) { errno = ENOSYS; return -1; }
        if (real_mkdir(dir, 0777) < 0 && errno != EEXIST) return -1;
        struct stat st;
        if (bn_py_lstat_raw(dir, &st) < 0) return -1;
        if (!S_ISDIR(st.st_mode)) { errno = ENOTDIR; return -1; }
    }

    int dfd = bn_py_open_raw(dir, O_RDONLY | O_DIRECTORY | O_CLOEXEC |
                                      O_NOFOLLOW, 0);
    if (dfd < 0) return -1;

    typedef int (*flock_fn)(int, int);
    static _Thread_local flock_fn real_flock;
    REAL(real_flock, "flock");
    if (!real_flock) {
        bn_py_close_raw(dfd);
        errno = ENOSYS;
        return -1;
    }
    if (real_flock(dfd, LOCK_EX) < 0) {
        int saved = errno;
        bn_py_close_raw(dfd);
        errno = saved;
        return -1;
    }
    *fd_out = dfd;
    return 0;
}

static void bn_py_sem_unlock_dir(int dfd) {
    typedef int (*flock_fn)(int, int);
    static _Thread_local flock_fn real_flock;
    REAL(real_flock, "flock");
    if (real_flock) (void)real_flock(dfd, LOCK_UN);
    bn_py_close_raw(dfd);
}

static void bn_py_sem_detach_name_locked(const char *name) {
    for (struct bn_py_sem_entry *e = bn_py_sem_entries; e; e = e->next) {
        if (e->name && !strcmp(e->name, name)) {
            free(e->name);
            e->name = NULL;
        }
    }
}

static struct bn_py_sem_entry *bn_py_sem_find_ptr_locked(sem_t *sem) {
    for (struct bn_py_sem_entry *e = bn_py_sem_entries; e; e = e->next)
        if (e->sem == sem) return e;
    return NULL;
}

static sem_t *bn_py_sem_fail_locked(int dfd, int error) {
    if (dfd >= 0) bn_py_sem_unlock_dir(dfd);
    (void)pthread_mutex_unlock(&bn_py_sem_mutex);
    errno = error;
    return SEM_FAILED;
}

static int bn_py_sem_temp_path(const char *dir, char *buf, size_t size) {
    static unsigned long sequence;
    sequence++;
    unsigned long long identity = bn_py_sem_self_identity();
    int written;
    if (identity)
        written = snprintf(buf, size,
                           "%s/" BN_PY_SEM_TEMP_PREFIX "%ld-%llu-%lu", dir,
                           (long)getpid(), identity, sequence);
    else
        written = snprintf(buf, size, "%s/" BN_PY_SEM_TEMP_PREFIX "%ld-%lu",
                           dir, (long)getpid(), sequence);
    if (written < 0 || (size_t)written >= size) {
        errno = ENAMETOOLONG;
        return -1;
    }
    return 0;
}

static int bn_py_sem_decimal(const char **cursor, unsigned long long *value) {
    const char *p = *cursor;
    if (*p < '0' || *p > '9') return -1;
    if (p[0] == '0' && p[1] >= '0' && p[1] <= '9') return -1;
    char *end = NULL;
    errno = 0;
    unsigned long long parsed = strtoull(p, &end, 10);
    if (end == p || errno == ERANGE) return -1;
    *cursor = end;
    *value = parsed;
    return 0;
}

// New temp names are pid-starttime-sequence.  The two-component pid-sequence
// form is the pre-recovery protocol; it is still recognised so an upgrade can
// remove old debris, but its lack of a starttime makes it subject to a grace
// period.  Anything else is foreign and is left alone.
static int bn_py_sem_parse_temp_name(const char *name, pid_t *pid_out,
                                     unsigned long long *identity_out,
                                     int *legacy_out) {
    const char *p = name;
    size_t prefix = sizeof BN_PY_SEM_TEMP_PREFIX - 1;
    if (strncmp(p, BN_PY_SEM_TEMP_PREFIX, prefix)) return -1;
    p += prefix;

    unsigned long long pid, first, second;
    if (bn_py_sem_decimal(&p, &pid) < 0) return -1;
    if (*p++ != '-') return -1;
    if (bn_py_sem_decimal(&p, &first) < 0) return -1;
    if (*p == '-') {
        p++;
        if (bn_py_sem_decimal(&p, &second) < 0 || *p != '\0') return -1;
        *identity_out = first;
        *legacy_out = 0;
        (void)second;
    } else if (*p == '\0') {
        *identity_out = 0;
        *legacy_out = 1;
    } else {
        return -1;
    }
    if (pid == 0 || pid > (unsigned long long)INT_MAX) return -1;
    *pid_out = (pid_t)pid;
    return 0;
}

static int bn_py_sem_creator_stale(pid_t pid, unsigned long long identity) {
    if (pid <= 0 || identity == 0) return 0;
    unsigned long long actual = 0;
    char state = 0;
    int found = bn_py_sem_proc_identity(pid, &actual, &state);
    if (found == 1) return 1;
    if (found < 0) return 0; // Unknown identity is not proof of staleness.
    // The caller holds the directory lock, so an identity mismatch cannot be
    // an in-protocol creator: it is either pid reuse or a name the creator
    // never published.  The name's token is evidence of the writer, not a
    // liveness oracle for the pid that happens to carry it now.
    if (actual != identity) return 1;
    if (state == 'Z' || state == 'X' || state == 'x') return 1;
    return 0;
}

static int bn_py_sem_file_header(int dirfd, const char *name,
                                 uint64_t *magic_out, uint32_t *version_out,
                                 uint32_t *reserved_out,
                                 struct stat *st_out) {
    int fd = bn_py_openat_raw(dirfd, name,
                              O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK, 0);
    if (fd < 0) return -1;
    struct stat st;
    int rc = -1;
    if (bn_py_fstat_raw(fd, &st) < 0 || !S_ISREG(st.st_mode)) goto out;
    unsigned char tail[sizeof(uint64_t) + 2 * sizeof(uint32_t)];
    ssize_t got = pread(fd, tail, sizeof tail,
                        (off_t)offsetof(struct bn_py_sem_slot, magic));
    if (got != (ssize_t)sizeof tail) goto out;
    uint64_t magic;
    uint32_t version;
    uint32_t reserved;
    memcpy(&magic, tail, sizeof magic);
    memcpy(&version, tail + sizeof(uint64_t), sizeof version);
    memcpy(&reserved, tail + sizeof(uint64_t) + sizeof(uint32_t),
           sizeof reserved);
    *magic_out = magic;
    *version_out = version;
    *reserved_out = reserved;
    *st_out = st;
    rc = 0;
out:
    (void)bn_py_close_raw(fd);
    return rc;
}

// Called only while the semaphore directory flock is held.  A creator holds
// that same lock from before its temp file exists until after publication, so
// no live creator can be in the middle of the protocol here.  The identity
// check is a second guard: files owned by a still-live creator are left for a
// later call, and files whose pid now belongs to a different process are
// unambiguously stale.
static int bn_py_sem_cleanup_locked(int dfd) {
    struct stat dir_st;
    if (bn_py_fstat_raw(dfd, &dir_st) < 0 || !S_ISDIR(dir_st.st_mode))
        return -1;
    uid_t caller = bn_py_geteuid_raw();
    if (caller == (uid_t)-1) return -1;

    // Keep the lock-bearing directory description out of a concurrent exec.
    // dup() would clear CLOEXEC until fdopendir() gets a chance to set it.
    int scanfd = fcntl(dfd, F_DUPFD_CLOEXEC, 0);
    if (scanfd < 0) return -1;
    DIR *dir = fdopendir(scanfd);
    if (!dir) {
        (void)bn_py_close_raw(scanfd);
        return -1;
    }

    int removed = 0;
    // Removing entries while readdir walks a directory may skip neighbours.
    // Re-scan a bounded number of times; that matters when a crash left many
    // files and keeps the work bounded for a hostile directory.
    for (int pass = 0; pass < 8; pass++) {
        int removed_here = 0;
        int scanned = 0;
        struct dirent *entry;
        rewinddir(dir);
        while ((entry = readdir(dir)) != NULL) {
            if (++scanned > 4096) break;
            if (strncmp(entry->d_name, BN_PY_SEM_TEMP_PREFIX,
                        sizeof BN_PY_SEM_TEMP_PREFIX - 1))
                continue;
            pid_t pid = 0;
            unsigned long long identity = 0;
            int legacy = 0;
            if (bn_py_sem_parse_temp_name(entry->d_name, &pid, &identity,
                                          &legacy) < 0)
                continue;

            struct stat st;
            if (bn_py_fstatat_raw(dfd, entry->d_name, &st,
                                  AT_SYMLINK_NOFOLLOW) < 0)
                continue;
            if (!S_ISREG(st.st_mode) || st.st_uid != caller)
                continue;
            if (st.st_size > (off_t)sizeof(struct bn_py_sem_slot))
                continue;

            if (legacy) {
                time_t now = time(NULL);
                // Legacy names carry no starttime, so a live pid is not
                // proof of staleness even though the held directory lock
                // already excludes an in-protocol creator.  Preserve it
                // until the pid disappears; future mtimes are not old.
                unsigned long long legacy_start = 0;
                char legacy_state = 0;
                int found = bn_py_sem_proc_identity(pid, &legacy_start,
                                                    &legacy_state);
                if (found < 0) continue;
                if (found == 0 && legacy_state != 'Z' &&
                    legacy_state != 'X' && legacy_state != 'x')
                    continue;
                if (now <= st.st_mtime ||
                    now - st.st_mtime < BN_PY_SEM_LEGACY_GRACE)
                    continue;
            } else {
                if (identity == 0 ||
                    !bn_py_sem_creator_stale(pid, identity))
                    continue;
            }

            // A completed header must carry the in-progress magic.  A final
            // magic is also accepted: link() publication can briefly leave a
            // fully formed inode under both names, and a kill after setting
            // the final magic but before rename must not defeat cleanup.
            // Zero/partial files are the tiny open-to-pwrite window.
            if (st.st_size >=
                (off_t)(offsetof(struct bn_py_sem_slot, magic) +
                        sizeof(uint64_t))) {
                uint64_t magic = 0;
                uint32_t version = 0;
                uint32_t reserved = 0;
                struct stat opened;
                if (bn_py_sem_file_header(dfd, entry->d_name, &magic,
                                          &version, &reserved, &opened) < 0)
                    continue;
                if (opened.st_dev != st.st_dev || opened.st_ino != st.st_ino)
                    continue;
                if (legacy) {
                    // The old protocol only ever left an all-zero header
                    // (killed in sem_init) or no file at all.  Recognise our
                    // explicit temp magic for the identity-fallback naming
                    // path, and preserve every other completed header.
                    if (version != 0 && version != BN_PY_SEM_VERSION)
                        continue;
                    if (version == 0 && magic != 0) continue;
                    if (version == BN_PY_SEM_VERSION &&
                        magic != BN_PY_SEM_TEMP_MAGIC)
                        continue;
                } else if (version != BN_PY_SEM_VERSION) {
                    // Unknown or future protocol: never clean it.
                    continue;
                } else if (magic == BN_PY_SEM_MAGIC) {
                    // The requested final name may itself look like a temp
                    // name.  A matching recorded hash proves this inode was
                    // published under the name now visible.  Zero is an old
                    // file without the hash and is preserved conservatively.
                    if (reserved == 0 ||
                        reserved == bn_py_sem_name_hash(entry->d_name))
                        continue;
                } else if (magic != BN_PY_SEM_TEMP_MAGIC) {
                    continue;
                }
            } else if (legacy && st.st_size != 0) {
                continue;
            }

            struct stat current;
            if (bn_py_fstatat_raw(dfd, entry->d_name, &current,
                                  AT_SYMLINK_NOFOLLOW) < 0)
                continue;
            if (current.st_dev != st.st_dev || current.st_ino != st.st_ino ||
                current.st_size != st.st_size)
                continue;
            if (bn_py_unlinkat_raw(dfd, entry->d_name, 0) == 0) {
                removed++;
                removed_here++;
            }
        }
        if (!removed_here) break;
    }
    closedir(dir);
    return removed;
}

// Publish the fully formed inode under the final name.  RENAME_NOREPLACE is
// preferred so an unexpected existing entry is never overwritten; link() is
// the fallback for kernels/filesystems that reject the flag.  Both operations
// are atomic with respect to readers of the final name.
static int bn_py_sem_publish(const char *temp, const char *final) {
    typedef int (*renameat2_fn)(int, const char *, int, const char *,
                                unsigned int);
    static _Thread_local renameat2_fn real_renameat2;
    REAL(real_renameat2, "renameat2");
    if (real_renameat2) {
        if (real_renameat2(AT_FDCWD, temp, AT_FDCWD, final,
                           RENAME_NOREPLACE) == 0)
            return 0;
        if (errno != ENOSYS && errno != EINVAL) return -1;
    }

    typedef int (*link_fn)(const char *, const char *);
    static _Thread_local link_fn real_link;
    REAL(real_link, "link");
    if (real_link) {
        if (real_link(temp, final) == 0) {
            (void)bn_py_unlink_raw(temp);
            return 0;
        }
        return -1;
    }
    errno = ENOSYS;
    return -1;
}

// Create a private file in the semaphore directory and initialise it
// completely.  Nothing under the final name changes until publish succeeds.
static int bn_py_sem_create_temp(const char *dir, const char *final,
                                 mode_t mode,
                                 unsigned int value, char *temp,
                                 size_t temp_size, int *fd_out,
                                 void **base_out, struct stat *st_out) {
    int fd = -1;
    for (int attempt = 0; attempt < 100; attempt++) {
        if (bn_py_sem_temp_path(dir, temp, temp_size) < 0) return -1;
        // A legal final name can itself look like a temp name.  Never let a
        // generated private name be the requested final name.
        if (!strcmp(temp, final)) continue;
        fd = bn_py_open_raw(temp, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW |
                                      O_CLOEXEC, mode);
        if (fd >= 0) break;
        if (errno != EEXIST) return -1;
    }
    if (fd < 0) {
        errno = EEXIST;
        return -1;
    }

    typedef int (*fstat_fn)(int, struct stat *);
    static _Thread_local fstat_fn real_fstat;
    REAL(real_fstat, "fstat");
    typedef int (*ftruncate_fn)(int, off_t);
    static _Thread_local ftruncate_fn real_ftruncate;
    REAL(real_ftruncate, "ftruncate");
    typedef ssize_t (*pwrite_fn)(int, const void *, size_t, off_t);
    static _Thread_local pwrite_fn real_pwrite;
    REAL(real_pwrite, "pwrite");
    typedef int (*fsync_fn)(int);
    static _Thread_local fsync_fn real_fsync;
    REAL(real_fsync, "fsync");

    void *base = MAP_FAILED;
    int saved = 0;
    if (!real_fstat || !real_ftruncate || !real_pwrite || !real_fsync) {
        saved = ENOSYS;
        goto fail;
    }
    if (real_fstat(fd, st_out) < 0) {
        saved = errno;
        goto fail;
    }
    if (st_out->st_size != 0) {
        saved = EINVAL;
        goto fail;
    }

    // Stamp the in-progress magic while the file is still empty apart from
    // this header.  A SIGKILL from here on leaves a file that cleanup can
    // identify as ours; the only remaining ambiguous state is a zero or
    // partial header immediately after open().
    struct bn_py_sem_slot header;
    memset(&header, 0, sizeof header);
    header.magic = BN_PY_SEM_TEMP_MAGIC;
    header.version = BN_PY_SEM_VERSION;
    const char *leaf = strrchr(final, '/');
    header.reserved = bn_py_sem_name_hash(leaf ? leaf + 1 : final);
    ssize_t wrote;
    do {
        wrote = real_pwrite(fd, &header, sizeof header, 0);
    } while (wrote < 0 && errno == EINTR);
    if (wrote != (ssize_t)sizeof header) {
        saved = wrote < 0 ? errno : EIO;
        goto fail;
    }
    if (real_ftruncate(fd, (off_t)sizeof(struct bn_py_sem_slot)) < 0) {
        saved = errno;
        goto fail;
    }
    base = mmap(NULL, sizeof(struct bn_py_sem_slot),
                PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (base == MAP_FAILED) {
        saved = errno;
        goto fail;
    }

    struct bn_py_sem_slot *slot = (struct bn_py_sem_slot *)base;
    slot->magic = BN_PY_SEM_TEMP_MAGIC;
    slot->version = BN_PY_SEM_VERSION;
    if (sem_init(&slot->sem, 1, value) != 0) {
        saved = errno;
        goto fail;
    }
    slot->magic = BN_PY_SEM_MAGIC;
    slot->version = BN_PY_SEM_VERSION;
    if (real_fsync(fd) < 0) {
        saved = errno;
        goto fail;
    }

    *fd_out = fd;
    *base_out = base;
    return 0;

fail:
    if (base != MAP_FAILED) munmap(base, sizeof(struct bn_py_sem_slot));
    bn_py_close_raw(fd);
    (void)bn_py_unlink_raw(temp);
    errno = saved;
    return -1;
}

static int bn_py_sem_map_existing(const char *path, void **base_out,
                                  struct stat *st_out) {
    int fd = bn_py_open_raw(path, O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0);
    if (fd < 0) return -1;

    typedef int (*fstat_fn)(int, struct stat *);
    static _Thread_local fstat_fn real_fstat;
    REAL(real_fstat, "fstat");
    int saved = 0;
    if (!real_fstat) {
        saved = ENOSYS;
        goto fail;
    }
    if (real_fstat(fd, st_out) < 0) {
        saved = errno;
        goto fail;
    }
    if (!S_ISREG(st_out->st_mode) ||
        st_out->st_size != (off_t)sizeof(struct bn_py_sem_slot)) {
        saved = EINVAL;
        goto fail;
    }

    void *base = mmap(NULL, sizeof(struct bn_py_sem_slot),
                      PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (base == MAP_FAILED) {
        saved = errno;
        goto fail;
    }
    struct bn_py_sem_slot *slot = (struct bn_py_sem_slot *)base;
    if (slot->magic != BN_PY_SEM_MAGIC ||
        slot->version != BN_PY_SEM_VERSION) {
        munmap(base, sizeof *slot);
        saved = EINVAL;
        goto fail;
    }

    bn_py_close_raw(fd);
    *base_out = base;
    return 0;

fail:
    bn_py_close_raw(fd);
    errno = saved;
    return -1;
}

sem_t *sem_open(const char *name, int oflag, ...) {
    typedef sem_t *(*fn_t)(const char *, int, ...);
    static _Thread_local fn_t real;
    REAL(real, "sem_open");

    if (!bn_rootfs()) {
        if (!real) { errno = ENOSYS; return SEM_FAILED; }
        if (oflag & O_CREAT) {
            va_list ap;
            va_start(ap, oflag);
            mode_t mode = va_arg(ap, mode_t);
            unsigned int value = va_arg(ap, unsigned int);
            va_end(ap);
            return real(name, oflag, mode, value);
        }
        return real(name, oflag);
    }

    mode_t mode = 0;
    unsigned int value = 0;
    if (oflag & O_CREAT) {
        va_list ap;
        va_start(ap, oflag);
        mode = va_arg(ap, mode_t);
        value = va_arg(ap, unsigned int);
        va_end(ap);
    }

    if (bn_py_ipc_name(name) < 0) return SEM_FAILED;

    // glibc checks the value before an O_EXCL open, so an invalid value wins
    // over EEXIST.  O_CREAT without O_EXCL ignores value for an existing
    // object and only validates it when this call actually initialises.
    if ((oflag & (O_CREAT | O_EXCL)) == (O_CREAT | O_EXCL) &&
        value > (unsigned int)SEM_VALUE_MAX) {
        errno = EINVAL;
        return SEM_FAILED;
    }

    char path[PATH_MAX];
    if (bn_py_sem_path(name, path, sizeof path) < 0) return SEM_FAILED;
    char dir[PATH_MAX];
    if (bn_py_ipc_path("/dev/shm/.bionilux-sem", dir, sizeof dir) < 0)
        return SEM_FAILED;

    bn_py_sem_registry_init();
    (void)pthread_mutex_lock(&bn_py_sem_mutex);

    // A handle is reusable only while the name still refers to the same inode.
    // If another process has unlinked and recreated it, the old entry stays in
    // the list for sem_close() but loses its name here.
    for (struct bn_py_sem_entry *e = bn_py_sem_entries; e; e = e->next) {
        if (!e->name || strcmp(e->name, name)) continue;
        struct stat st;
        if (bn_py_lstat_raw(path, &st) == 0 && S_ISREG(st.st_mode) &&
            st.st_dev == e->dev && st.st_ino == e->ino) {
            if (oflag & O_EXCL) {
                (void)pthread_mutex_unlock(&bn_py_sem_mutex);
                errno = EEXIST;
                return SEM_FAILED;
            }
            e->refs++;
            (void)pthread_mutex_unlock(&bn_py_sem_mutex);
            return e->sem;
        }
    }
    bn_py_sem_detach_name_locked(name);

    int dfd = -1;
    if (bn_py_sem_lock_dir((oflag & O_CREAT) != 0, &dfd) < 0)
        return bn_py_sem_fail_locked(-1, errno);
    (void)bn_py_sem_cleanup_locked(dfd);

    void *base = NULL;
    struct stat st;
    int published = 0;
    char temp[PATH_MAX];
    temp[0] = '\0';

    if (oflag & O_CREAT) {
        struct stat current;
        int have = bn_py_lstat_raw(path, &current) == 0;
        if (!have && errno != ENOENT)
            return bn_py_sem_fail_locked(dfd, errno);
        if (have) {
            if (oflag & O_EXCL)
                return bn_py_sem_fail_locked(dfd, EEXIST);
        } else {
            int tfd = -1;
            void *tbase = NULL;
            if (bn_py_sem_create_temp(dir, path, mode, value, temp,
                                      sizeof temp, &tfd, &tbase, &st) < 0)
                return bn_py_sem_fail_locked(dfd, errno);
            if (bn_py_sem_publish(temp, path) < 0) {
                int saved = errno;
                munmap(tbase, sizeof(struct bn_py_sem_slot));
                bn_py_close_raw(tfd);
                (void)bn_py_unlink_raw(temp);
                if (saved != EEXIST)
                    return bn_py_sem_fail_locked(dfd, saved);
                if (oflag & O_EXCL)
                    return bn_py_sem_fail_locked(dfd, EEXIST);
            } else {
                bn_py_close_raw(tfd);
                base = tbase;
                published = 1;
            }
        }
    }

    if (!published &&
        bn_py_sem_map_existing(path, &base, &st) < 0)
        return bn_py_sem_fail_locked(dfd, errno);

    struct bn_py_sem_slot *slot = (struct bn_py_sem_slot *)base;
    char *copy = strdup(name);
    struct bn_py_sem_entry *entry =
        (struct bn_py_sem_entry *)malloc(sizeof *entry);
    if (!copy || !entry) {
        free(copy);
        free(entry);
        munmap(base, sizeof *slot);
        if (published) (void)bn_py_unlink_raw(path);
        return bn_py_sem_fail_locked(dfd, ENOMEM);
    }
    entry->name = copy;
    entry->sem = &slot->sem;
    entry->dev = st.st_dev;
    entry->ino = st.st_ino;
    entry->refs = 1;
    entry->next = bn_py_sem_entries;
    bn_py_sem_entries = entry;

    bn_py_sem_unlock_dir(dfd);
    (void)pthread_mutex_unlock(&bn_py_sem_mutex);
    return &slot->sem;
}

int sem_close(sem_t *sem) {
    typedef int (*fn_t)(sem_t *);
    static _Thread_local fn_t real;
    REAL(real, "sem_close");

    if (!bn_rootfs()) {
        if (!real) { errno = ENOSYS; return -1; }
        return real(sem);
    }
    bn_py_sem_registry_init();
    (void)pthread_mutex_lock(&bn_py_sem_mutex);
    struct bn_py_sem_entry *entry = bn_py_sem_find_ptr_locked(sem);
    if (!entry) {
        (void)pthread_mutex_unlock(&bn_py_sem_mutex);
        errno = EINVAL;
        return -1;
    }
    if (entry->refs > 1) {
        entry->refs--;
        (void)pthread_mutex_unlock(&bn_py_sem_mutex);
        return 0;
    }

    struct bn_py_sem_entry **link = &bn_py_sem_entries;
    while (*link && *link != entry) link = &(*link)->next;
    if (*link == entry) *link = entry->next;
    free(entry->name);
    free(entry);

    int rc = munmap(sem, sizeof(struct bn_py_sem_slot));
    (void)pthread_mutex_unlock(&bn_py_sem_mutex);
    return rc;
}

int sem_unlink(const char *name) {
    typedef int (*fn_t)(const char *);
    static _Thread_local fn_t real;
    REAL(real, "sem_unlink");
    if (!bn_rootfs()) {
        if (!real) { errno = ENOSYS; return -1; }
        return real(name);
    }
    if (bn_py_ipc_name(name) < 0) return -1;
    char path[PATH_MAX];
    if (bn_py_sem_path(name, path, sizeof path) < 0) return -1;

    bn_py_sem_registry_init();
    (void)pthread_mutex_lock(&bn_py_sem_mutex);

    int dfd = -1;
    if (bn_py_sem_lock_dir(0, &dfd) < 0) {
        int saved = errno;
        if (saved == ENOENT) bn_py_sem_detach_name_locked(name);
        (void)pthread_mutex_unlock(&bn_py_sem_mutex);
        errno = saved;
        return -1;
    }
    (void)bn_py_sem_cleanup_locked(dfd);

    int rc = bn_py_unlink_raw(path);
    int saved = errno;
    if (rc == 0 || saved == ENOENT) bn_py_sem_detach_name_locked(name);
    bn_py_sem_unlock_dir(dfd);
    (void)pthread_mutex_unlock(&bn_py_sem_mutex);
    errno = saved;
    return rc;
}

#endif // BIONILUX_COMPAT_PYTHON_INC_C
