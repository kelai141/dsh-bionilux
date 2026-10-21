#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <dlfcn.h>
#include <fcntl.h>
#include <limits.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/utsname.h>
#include <sys/stat.h>
#include <unistd.h>

static void *legacy_libc_symbol(void *libc, const char *name, const char **version) {
    static const char *const versions[] = {
        "GLIBC_2.2.5", "GLIBC_2.17", "GLIBC_2.0", "GLIBC_2.1", "GLIBC_2.2"
    };
    for (size_t i = 0; i < sizeof versions / sizeof versions[0]; i++) {
        void *p = dlvsym(libc, name, versions[i]);
        if (p) {
            if (version) *version = versions[i];
            return p;
        }
    }
    return NULL;
}

static void assert_guest_mkstemp(void *handle, const char *label) {
    int (*mkstemp_fn)(char *) = (int (*)(char *))dlsym(handle, "mkstemp");
    assert(mkstemp_fn);
    const char *template_env = getenv("BN_MKSTEMP_TEMPLATE");
    assert(template_env && *template_env);
    char tmpl[PATH_MAX];
    assert(strlen(template_env) < sizeof tmpl);
    strcpy(tmpl, template_env);
    int fd = mkstemp_fn(tmpl);
    assert(fd >= 0);
    assert(!strncmp(tmpl, "/tmp/", 5));
    struct stat st;
    assert(fstat(fd, &st) == 0 && S_ISREG(st.st_mode));
    const char *physical_tmp = getenv("BN_TMP_PHYSICAL");
    if (physical_tmp && *physical_tmp) {
        const char *base = strrchr(tmpl, '/');
        assert(base && base[1]);
        char physical[PATH_MAX];
        int n = snprintf(physical, sizeof physical, "%s/%s", physical_tmp, base + 1);
        assert(n > 0 && (size_t)n < sizeof physical);
        assert(access(physical, F_OK) == 0);
    }
    assert(close(fd) == 0);
    assert(unlink(tmpl) == 0);
    errno = 0;
    assert(access(tmpl, F_OK) == -1 && errno == ENOENT);
    printf("%s-mkstemp: PASS\n", label);
}

int main(void) {
    setvbuf(stdout, NULL, _IONBF, 0);
    struct utsname info;
    assert(uname(&info) == 0);
#if defined(__x86_64__)
    assert(!strcmp(info.machine, "x86_64"));
#elif defined(__aarch64__)
    assert(!strcmp(info.machine, "aarch64"));
#endif
    char own[64], buffer[PATH_MAX];
    snprintf(own, sizeof own, "/proc/%ld/exe", (long)getpid());
    const char *paths[] = {"/proc/self/exe", "/proc/thread-self/exe", own};
    for (size_t i = 0; i < sizeof paths / sizeof paths[0]; i++) {
        ssize_t n = readlink(paths[i], buffer, sizeof buffer - 1);
        assert(n > 0);
        buffer[n] = 0;
        assert(!strcmp(buffer, "/usr/bin/identity-probe"));
        assert(realpath(paths[i], buffer) == buffer);
        assert(!strcmp(buffer, "/usr/bin/identity-probe"));
        char *allocated = realpath(paths[i], NULL);
        assert(allocated && !strcmp(allocated, buffer));
        free(allocated);
    }
    assert(readlink(paths[0], buffer, 4) == 4);
    assert(!memcmp(buffer, "/usr", 4));
    errno = 0;
    assert(readlink(paths[0], buffer, 0) == -1 && errno == EINVAL);
    void *libc = dlopen("libc.so.6", RTLD_NOW | RTLD_LOCAL);
    assert(libc);

    // The legacy stat ABI is used by binary-distributed managed runtimes. A
    // preload exports __xstat64 even where the host libc has no such symbol,
    // so probe the real libc handle with dlvsym (dlsym would be redirected by
    // the hook under test) and skip this block when the ABI is absent.
    typedef int (*xstat_fn)(int, const char *, struct stat64 *);
    const char *legacy_version = NULL;
    xstat_fn real_xs = (xstat_fn)legacy_libc_symbol(libc, "__xstat64", &legacy_version);
    if (real_xs) {
        xstat_fn xs = (xstat_fn)dlsym(RTLD_DEFAULT, "__xstat64");
        assert(xs);
        struct stat64 st;
#if defined(__x86_64__)
        const int version = 1;
#else
        const int version = 0;
#endif
        assert(xs(version, "/usr/bin/identity-probe", &st) == 0);
        assert(S_ISREG(st.st_mode));
        assert(st.st_uid == 0 && st.st_gid == 0);
        errno = 0;
        assert(xs(version, "/bn-missing-file", &st) == -1 && errno == ENOENT);
        errno = 0;
        assert(xs(-1, "/usr/bin/identity-probe", &st) == -1 && errno == EINVAL);

        // The real libc old ABI has no path mapping. Prove it works on the
        // physical executable path while the wrapper handles the guest path.
        Dl_info info;
        assert(dladdr((void *)&main, &info) && info.dli_fname);
        assert(real_xs(version, info.dli_fname, &st) == 0);
        assert(S_ISREG(st.st_mode));
        printf("legacy-xstat: tested via %s\n", legacy_version);
    } else {
        printf("legacy-xstat: skipped (libc has no versioned __xstat64)\n");
    }

    // An explicit libc handle must still select our path/identity wrappers.
    int (*mode)(const char *, mode_t) =
        (int (*)(const char *, mode_t))dlsym(libc, "chmod");
    int (*libc_stat)(const char *, struct stat *) =
        (int (*)(const char *, struct stat *))dlsym(libc, "stat");
    assert(mode && libc_stat);
    assert(mode("/usr/bin/identity-probe", 0700) == 0);
    struct stat st;
    assert(libc_stat("/usr/bin/identity-probe", &st) == 0);
    assert(S_ISREG(st.st_mode));
    assert((st.st_mode & 0777) == 0700);
    assert(st.st_uid == 0 && st.st_gid == 0);

    // Julia's custom depot path reaches glibc mkstemp through an explicit
    // libc handle. The generic own-DSO dlsym guard must still select the hook,
    // otherwise the file is created on the host /tmp instead of rootfs /tmp.
    assert_guest_mkstemp(libc, "libc");
    assert(dlclose(libc) == 0);

    // A lookup on another DSO may resolve its libc dependency. The dispatcher
    // judges the resolved implementation, not the requested handle name.
    const char *chain_path = getenv("BN_CHAIN_LIBRARY");
    assert(chain_path && *chain_path);
    void *chain = dlopen(chain_path, RTLD_NOW);
    assert(chain);
    assert_guest_mkstemp(chain, "chain");
    assert(dlclose(chain) == 0);

    // A same-named symbol defined by a non-libc DSO must be returned as-is.
    const char *custom_path = getenv("BN_CUSTOM_LIBRARY");
    assert(custom_path && *custom_path);
    void *custom = dlopen(custom_path, RTLD_NOW);
    assert(custom);
    int (*custom_mkstemp)(char *) = (int (*)(char *))dlsym(custom, "mkstemp");
    assert(custom_mkstemp);
    char sentinel[] = "/tmp/not-a-template";
    assert(custom_mkstemp(sentinel) == 4242);
    assert(dlclose(custom) == 0);
    puts("custom-mkstemp: PASS");

    int (*lookup)(void) = (int (*)(void))dlsym(RTLD_DEFAULT, "bn_chain_lookup");
    assert(lookup && lookup() == 22);
    puts("rtld-next: PASS");

    // RTLD_DEEPBIND makes a plugin prefer libc over the preload. In rootfs
    // mode hooks.c drops that flag so the plugin still sees guest paths.
    const char *deep = getenv("BN_DEEP_LIBRARY");
    assert(deep && *deep);
    void *deep_handle = dlopen(deep, RTLD_NOW | RTLD_DEEPBIND);
    assert(deep_handle);
    assert_guest_mkstemp(deep_handle, "deep");
    bool (*deep_probe)(void) = (bool (*)(void))dlsym(deep_handle, "bn_deep_probe");
    assert(deep_probe && deep_probe());
    assert(dlclose(deep_handle) == 0);
    puts("deepbind: PASS");
    puts("identity/proc-exe: PASS");
}
