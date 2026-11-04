// Shadow account database compatibility for Android guests.
//
// This fragment is included before the stat hooks. It supplies two pieces
// that must remain real across processes:
//
//   1. lckpwdf()/ulckpwdf() on the guest's physical /etc/.pwd.lock, using a
//      bounded fcntl write lock.  glibc's implementation opens /etc/.pwd.lock
//      through a hidden libc entry point, which bypasses our path mapper.
//   2. A tiny view of the link count shadow's commonio.c needs between a
//      successful O_EXCL copy fallback and its stat(file).  Android refuses
//      the hard link; shadow nevertheless requires st_nlink == 2 for exactly
//      /etc/{passwd,shadow,group,gshadow}.<pid> -> /etc/<db>.lock.
//
// Nothing here changes an ordinary stat result, a path outside the guest, or
// a hard link that the kernel accepted.  The record below is process-private
// and is removed as soon as either protocol path is unlinked or the recorded
// lock inode disappears.

#ifndef BN_SHADOW_LOCK_TIMEOUT_MS
#define BN_SHADOW_LOCK_TIMEOUT_MS 15000
#endif

#define BN_SHADOW_LOCK_PATH "/etc/.pwd.lock"
#define BN_SHADOW_RECORD_SLOTS 8

static pthread_mutex_t bn_shadow_lock_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_mutex_t bn_shadow_record_mutex = PTHREAD_MUTEX_INITIALIZER;
static int bn_shadow_lock_fd = -1;

static const char *const bn_shadow_databases[] = {
    "passwd", "shadow", "group", "gshadow"
};

struct bn_shadow_link_record {
    int used;
    dev_t source_dev;
    ino_t source_ino;
    dev_t target_dev;
    ino_t target_ino;
    char source[PATH_MAX];
    char target[PATH_MAX];
};

static struct bn_shadow_link_record bn_shadow_records[BN_SHADOW_RECORD_SLOTS];
static unsigned int bn_shadow_record_cursor;

// Return a canonical physical path.  Callers pass the result of bn_resolve()
// (or another physical path), never an unprocessed logical guest path.
static int bn_shadow_physical_path(int dirfd, const char *path,
                                   char *out, size_t size) {
    if (!path || !*path || size < 2) return 0;
    if (path[0] == '/') {
        bn_normalize(path, out, size);
        return 1;
    }

    char base[PATH_MAX], joined[PATH_MAX];
    if (!bn_dir_base(dirfd, base, sizeof base)) return 0;
    int n = snprintf(joined, sizeof joined, "%s/%s", base, path);
    if (n <= 0 || (size_t)n >= sizeof joined) return 0;
    bn_normalize(joined, out, size);
    return 1;
}

static int bn_shadow_real_lckpwdf(void) {
    typedef int (*fn_t)(void);
    static _Thread_local fn_t real;
    REAL(real, "lckpwdf");
    if (!real) { errno = ENOSYS; return -1; }
    return real();
}

static int bn_shadow_real_ulckpwdf(void) {
    typedef int (*fn_t)(void);
    static _Thread_local fn_t real;
    REAL(real, "ulckpwdf");
    if (!real) { errno = ENOSYS; return -1; }
    return real();
}

// glibc's lckpwdf() uses a hidden open, so a guest in this preload would lock
// the host's /etc/.pwd.lock (or fail).  Use the physical guest file and the
// same fcntl(F_WRLCK) protocol, with an explicit monotonic deadline rather
// than SIGALRM so the wait does not disturb the application's signals.
int lckpwdf(void) {
    if (!bn_rootfs()) return bn_shadow_real_lckpwdf();

    typedef int (*open_fn)(const char *, int, ...);
    typedef int (*fcntl_fn)(int, int, ...);
    typedef int (*close_fn)(int);
    static _Thread_local open_fn real_open;
    static _Thread_local fcntl_fn real_fcntl;
    static _Thread_local close_fn real_close;
    REAL(real_open, "open");
    REAL(real_fcntl, "fcntl");
    REAL(real_close, "close");
    if (!real_open || !real_fcntl || !real_close) {
        errno = ENOSYS;
        return -1;
    }

    char lock[PATH_MAX];
    const char *physical = bn_map(BN_SHADOW_LOCK_PATH, lock, sizeof lock);
    pthread_mutex_lock(&bn_shadow_lock_mutex);
    if (bn_shadow_lock_fd != -1) { // Same-process second lock, as in glibc.
        pthread_mutex_unlock(&bn_shadow_lock_mutex);
        return -1;
    }

    int fd = real_open(physical, O_WRONLY | O_CREAT | O_CLOEXEC, 0600);
    if (fd < 0) {
        pthread_mutex_unlock(&bn_shadow_lock_mutex);
        return -1;
    }

    struct flock fl;
    memset(&fl, 0, sizeof fl);
    fl.l_type = F_WRLCK;
    fl.l_whence = SEEK_SET;

    struct timespec start, now;
    clock_gettime(CLOCK_MONOTONIC, &start);
    for (;;) {
        if (real_fcntl(fd, F_SETLK, &fl) == 0) break;
        int error = errno;
        if (error != EACCES && error != EAGAIN && error != EINTR) {
            real_close(fd);
            pthread_mutex_unlock(&bn_shadow_lock_mutex);
            errno = error;
            return -1;
        }
        clock_gettime(CLOCK_MONOTONIC, &now);
        long long elapsed = (long long)(now.tv_sec - start.tv_sec) * 1000 +
                            (now.tv_nsec - start.tv_nsec) / 1000000;
        if (elapsed >= BN_SHADOW_LOCK_TIMEOUT_MS) {
            real_close(fd);
            pthread_mutex_unlock(&bn_shadow_lock_mutex);
            errno = EAGAIN;
            return -1;
        }
        struct timespec pause = {0, 20000000}; // 20 ms
        while (nanosleep(&pause, &pause) != 0 && errno == EINTR) {}
    }

    bn_shadow_lock_fd = fd;
    pthread_mutex_unlock(&bn_shadow_lock_mutex);
    return 0;
}

int ulckpwdf(void) {
    if (!bn_rootfs()) return bn_shadow_real_ulckpwdf();

    typedef int (*close_fn)(int);
    static _Thread_local close_fn real_close;
    REAL(real_close, "close");
    if (!real_close) { errno = ENOSYS; return -1; }

    pthread_mutex_lock(&bn_shadow_lock_mutex);
    if (bn_shadow_lock_fd == -1) {
        pthread_mutex_unlock(&bn_shadow_lock_mutex);
        return -1;
    }
    int fd = bn_shadow_lock_fd;
    bn_shadow_lock_fd = -1;
    int rc = real_close(fd); // close releases the process's fcntl lock
    int saved = errno;
    pthread_mutex_unlock(&bn_shadow_lock_mutex);
    errno = saved;
    return rc;
}

// Record the one substitution shadow deliberately checks.  Call this only
// after bn_copy_file() succeeded for a refused hard link.  The four database
// names and getpid() are checked against bn_rootfs()/etc exactly; anything
// else returns 0 and leaves stat untouched.
int bn_shadow_record_link(int fromfd, const char *from,
                          int tofd, const char *to) {
    const char *root = bn_rootfs();
    if (!root) return 0;

    char source[PATH_MAX], target[PATH_MAX];
    if (!bn_shadow_physical_path(fromfd, from, source, sizeof source) ||
        !bn_shadow_physical_path(tofd, to, target, sizeof target)) return 0;

    int protocol = 0;
    for (size_t i = 0; i < sizeof bn_shadow_databases / sizeof bn_shadow_databases[0]; i++) {
        char expected_source[PATH_MAX], expected_target[PATH_MAX];
        int a = snprintf(expected_source, sizeof expected_source, "%s/etc/%s.%ld",
                         root, bn_shadow_databases[i], (long)getpid());
        int b = snprintf(expected_target, sizeof expected_target, "%s/etc/%s.lock",
                         root, bn_shadow_databases[i]);
        if (a <= 0 || (size_t)a >= sizeof expected_source ||
            b <= 0 || (size_t)b >= sizeof expected_target) continue;
        char normalized_source[PATH_MAX], normalized_target[PATH_MAX];
        bn_normalize(expected_source, normalized_source, sizeof normalized_source);
        bn_normalize(expected_target, normalized_target, sizeof normalized_target);
        if (!strcmp(source, normalized_source) && !strcmp(target, normalized_target)) {
            protocol = 1;
            break;
        }
    }
    if (!protocol) return 0;

    typedef int (*stat_fn)(int, const char *, struct stat *, int);
    static _Thread_local stat_fn real_stat;
    REAL(real_stat, "fstatat");
    if (!real_stat) return 0;

    struct stat source_st, target_st;
    if (real_stat(AT_FDCWD, source, &source_st, AT_SYMLINK_NOFOLLOW) != 0 ||
        real_stat(AT_FDCWD, target, &target_st, AT_SYMLINK_NOFOLLOW) != 0 ||
        !S_ISREG(source_st.st_mode) || !S_ISREG(target_st.st_mode)) return 0;

    pthread_mutex_lock(&bn_shadow_record_mutex);
    struct bn_shadow_link_record *record = NULL;
    for (size_t i = 0; i < BN_SHADOW_RECORD_SLOTS; i++) {
        if (!bn_shadow_records[i].used) { record = &bn_shadow_records[i]; break; }
    }
    if (!record) {
        record = &bn_shadow_records[bn_shadow_record_cursor++ % BN_SHADOW_RECORD_SLOTS];
    }
    record->used = 1;
    record->source_dev = source_st.st_dev;
    record->source_ino = source_st.st_ino;
    record->target_dev = target_st.st_dev;
    record->target_ino = target_st.st_ino;
    memcpy(record->source, source, strlen(source) + 1);
    memcpy(record->target, target, strlen(target) + 1);
    pthread_mutex_unlock(&bn_shadow_record_mutex);
    return 1;
}

// BN_VIRT_STAT calls this after the real stat.  The path must be the same
// physical path bn_resolve() produced.  Only an exact recorded source inode,
// whose exact copied lock inode still exists, reports the missing link.
nlink_t bn_shadow_nlink(dev_t dev, ino_t ino, nlink_t nlink,
                        int dirfd, const char *path) {
    if (!bn_rootfs() || nlink != 1) return nlink;
    int saved = errno;
    char source[PATH_MAX];
    if (!bn_shadow_physical_path(dirfd, path, source, sizeof source)) {
        errno = saved;
        return nlink;
    }

    typedef int (*stat_fn)(int, const char *, struct stat *, int);
    static _Thread_local stat_fn real_stat;
    REAL(real_stat, "fstatat");
    if (!real_stat) { errno = saved; return nlink; }

    nlink_t result = nlink;
    pthread_mutex_lock(&bn_shadow_record_mutex);
    for (size_t i = 0; i < BN_SHADOW_RECORD_SLOTS; i++) {
        struct bn_shadow_link_record *record = &bn_shadow_records[i];
        if (!record->used || strcmp(record->source, source)) continue;
        if (record->source_dev != dev || record->source_ino != ino) {
            record->used = 0;
            break;
        }
        struct stat source_st, target_st;
        if (real_stat(AT_FDCWD, source, &source_st, AT_SYMLINK_NOFOLLOW) != 0 ||
            source_st.st_dev != record->source_dev ||
            source_st.st_ino != record->source_ino) {
            record->used = 0;
            break;
        }
        if (real_stat(AT_FDCWD, record->target, &target_st, AT_SYMLINK_NOFOLLOW) != 0 ||
            target_st.st_dev != record->target_dev ||
            target_st.st_ino != record->target_ino) {
            record->used = 0;
            break;
        }
        result = 2;
        break;
    }
    pthread_mutex_unlock(&bn_shadow_record_mutex);
    errno = saved;
    return result;
}

// Call after a successful unlink()/unlinkat()/remove() for the physical path.
// It drops both views when the single source or lock file goes away.
void bn_shadow_forget_path(int dirfd, const char *path) {
    if (!bn_rootfs()) return;
    int saved = errno;
    char gone[PATH_MAX];
    if (bn_shadow_physical_path(dirfd, path, gone, sizeof gone)) {
        pthread_mutex_lock(&bn_shadow_record_mutex);
        for (size_t i = 0; i < BN_SHADOW_RECORD_SLOTS; i++) {
            struct bn_shadow_link_record *record = &bn_shadow_records[i];
            if (record->used &&
                (!strcmp(record->source, gone) || !strcmp(record->target, gone)))
                record->used = 0;
        }
        pthread_mutex_unlock(&bn_shadow_record_mutex);
    }
    errno = saved;
}

// Integration helper: use after BN_VIRT_STAT at path-based stat call sites.
// `path` is the physical path returned by bn_resolve(), not the guest path.
#define BN_SHADOW_NLINK(st, dirfd, path) \
    do { \
        (st).st_nlink = bn_shadow_nlink((st).st_dev, (st).st_ino, \
                                         (st).st_nlink, (dirfd), (path)); \
    } while (0)
