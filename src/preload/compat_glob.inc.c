// glob()/glob64() path mapping.
//
// glibc implements glob() with hidden internal __opendir/__stat calls, so an
// absolute guest pattern never reaches the opendir()/stat() interposers in
// hooks.c.  It is looked up literally on the host and returns GLOB_NOMATCH.
// Relative patterns happen to work because "." resolves against the physical
// (already mapped) working directory.
//
// Give glibc the GLOB_ALTDIRFUNC callbacks instead: the pattern and the
// returned gl_pathv stay logical, while every directory and stat operation is
// resolved through the normal mapping helpers.  Callers that already supplied
// GLOB_ALTDIRFUNC keep their own callbacks unchanged.

#ifndef BIONILUX_COMPAT_GLOB_INCLUDED
#define BIONILUX_COMPAT_GLOB_INCLUDED

#include <glob.h>

typedef void *(*bn_glob_opendir_fn)(const char *);
typedef struct dirent *(*bn_glob_readdir_fn)(void *);
typedef void (*bn_glob_closedir_fn)(void *);
typedef int (*bn_glob_stat_fn)(const char *, struct stat *);

static void *bn_glob_opendir(const char *path) {
    typedef DIR *(*fn_t)(const char *);
    static _Thread_local fn_t real;
    REAL(real, "opendir");
    if (!real) {
        errno = ENOSYS;
        return NULL;
    }
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf));
}

static struct dirent *bn_glob_readdir(void *dir) {
    typedef struct dirent *(*fn_t)(DIR *);
    static _Thread_local fn_t real;
    REAL(real, "readdir");
    if (!real) {
        errno = ENOSYS;
        return NULL;
    }
    return real((DIR *)dir);
}

static void bn_glob_closedir(void *dir) {
    typedef int (*fn_t)(DIR *);
    static _Thread_local fn_t real;
    REAL(real, "closedir");
    if (real) (void)real((DIR *)dir);
}

static int bn_glob_stat(const char *path, struct stat *st) {
    typedef int (*fn_t)(const char *, struct stat *);
    static _Thread_local fn_t real;
    REAL(real, "stat");
    if (!real) {
        errno = ENOSYS;
        return -1;
    }
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), st);
}

static int bn_glob_lstat(const char *path, struct stat *st) {
    typedef int (*fn_t)(const char *, struct stat *);
    static _Thread_local fn_t real;
    REAL(real, "lstat");
    if (!real) {
        errno = ENOSYS;
        return -1;
    }
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), st);
}

int glob(const char *pattern, int flags,
         int (*errfunc)(const char *, int), glob_t *pglob) {
    typedef int (*fn_t)(const char *, int, int (*)(const char *, int), glob_t *);
    static _Thread_local fn_t real;
    REAL(real, "glob");
    if (!real) {
        errno = ENOSYS;
        return GLOB_ABORTED;
    }
    if (!pglob || !pattern || (flags & GLOB_ALTDIRFUNC) || !bn_rootfs())
        return real(pattern, flags, errfunc, pglob);

    // The callback fields may be uninitialized on a first call, so copy them
    // byte-for-byte and restore them the same way instead of reading values.
    bn_glob_opendir_fn saved_opendir;
    bn_glob_readdir_fn saved_readdir;
    bn_glob_closedir_fn saved_closedir;
    bn_glob_stat_fn saved_stat;
    bn_glob_stat_fn saved_lstat;
    memcpy(&saved_opendir, &pglob->gl_opendir, sizeof saved_opendir);
    memcpy(&saved_readdir, &pglob->gl_readdir, sizeof saved_readdir);
    memcpy(&saved_closedir, &pglob->gl_closedir, sizeof saved_closedir);
    memcpy(&saved_stat, &pglob->gl_stat, sizeof saved_stat);
    memcpy(&saved_lstat, &pglob->gl_lstat, sizeof saved_lstat);

    pglob->gl_opendir = bn_glob_opendir;
    pglob->gl_readdir = bn_glob_readdir;
    pglob->gl_closedir = bn_glob_closedir;
    pglob->gl_stat = bn_glob_stat;
    pglob->gl_lstat = bn_glob_lstat;

    int result = real(pattern, flags | GLOB_ALTDIRFUNC, errfunc, pglob);

    memcpy(&pglob->gl_opendir, &saved_opendir, sizeof saved_opendir);
    memcpy(&pglob->gl_readdir, &saved_readdir, sizeof saved_readdir);
    memcpy(&pglob->gl_closedir, &saved_closedir, sizeof saved_closedir);
    memcpy(&pglob->gl_stat, &saved_stat, sizeof saved_stat);
    memcpy(&pglob->gl_lstat, &saved_lstat, sizeof saved_lstat);
    if (result == 0) pglob->gl_flags &= ~GLOB_ALTDIRFUNC;
    return result;
}

typedef struct dirent64 *(*bn_glob64_readdir_fn)(void *);
typedef int (*bn_glob64_stat_fn)(const char *, struct stat64 *);

static struct dirent64 *bn_glob64_readdir(void *dir) {
    typedef struct dirent64 *(*fn_t)(DIR *);
    static _Thread_local fn_t real;
    REAL(real, "readdir64");
    if (!real) {
        errno = ENOSYS;
        return NULL;
    }
    return real((DIR *)dir);
}

static int bn_glob64_stat(const char *path, struct stat64 *st) {
    typedef int (*fn_t)(const char *, struct stat64 *);
    static _Thread_local fn_t real;
    REAL(real, "stat64");
    if (!real) {
        errno = ENOSYS;
        return -1;
    }
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), st);
}

static int bn_glob64_lstat(const char *path, struct stat64 *st) {
    typedef int (*fn_t)(const char *, struct stat64 *);
    static _Thread_local fn_t real;
    REAL(real, "lstat64");
    if (!real) {
        errno = ENOSYS;
        return -1;
    }
    char buf[PATH_MAX];
    return real(bn_resolve(AT_FDCWD, path, buf, sizeof buf), st);
}

int glob64(const char *pattern, int flags,
           int (*errfunc)(const char *, int), glob64_t *pglob) {
    typedef int (*fn_t)(const char *, int, int (*)(const char *, int), glob64_t *);
    static _Thread_local fn_t real;
    REAL(real, "glob64");
    if (!real) {
        errno = ENOSYS;
        return GLOB_ABORTED;
    }
    if (!pglob || !pattern || (flags & GLOB_ALTDIRFUNC) || !bn_rootfs())
        return real(pattern, flags, errfunc, pglob);

    bn_glob_opendir_fn saved_opendir;
    bn_glob64_readdir_fn saved_readdir;
    bn_glob_closedir_fn saved_closedir;
    bn_glob64_stat_fn saved_stat;
    bn_glob64_stat_fn saved_lstat;
    memcpy(&saved_opendir, &pglob->gl_opendir, sizeof saved_opendir);
    memcpy(&saved_readdir, &pglob->gl_readdir, sizeof saved_readdir);
    memcpy(&saved_closedir, &pglob->gl_closedir, sizeof saved_closedir);
    memcpy(&saved_stat, &pglob->gl_stat, sizeof saved_stat);
    memcpy(&saved_lstat, &pglob->gl_lstat, sizeof saved_lstat);

    pglob->gl_opendir = bn_glob_opendir;
    pglob->gl_readdir = bn_glob64_readdir;
    pglob->gl_closedir = bn_glob_closedir;
    pglob->gl_stat = bn_glob64_stat;
    pglob->gl_lstat = bn_glob64_lstat;

    int result = real(pattern, flags | GLOB_ALTDIRFUNC, errfunc, pglob);

    memcpy(&pglob->gl_opendir, &saved_opendir, sizeof saved_opendir);
    memcpy(&pglob->gl_readdir, &saved_readdir, sizeof saved_readdir);
    memcpy(&pglob->gl_closedir, &saved_closedir, sizeof saved_closedir);
    memcpy(&pglob->gl_stat, &saved_stat, sizeof saved_stat);
    memcpy(&pglob->gl_lstat, &saved_lstat, sizeof saved_lstat);
    if (result == 0) pglob->gl_flags &= ~GLOB_ALTDIRFUNC;
    return result;
}

#endif
