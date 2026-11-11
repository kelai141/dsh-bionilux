// Internal boundary tests; public API behavior is covered in runtime.c.
#include "../../src/preload/hooks.c"
#include <assert.h>
#include <sys/resource.h>

static void check_link_fallback(void) {
    assert(mkdir("/tmp/links-a", 0700) == 0);
    assert(mkdir("/tmp/links-b", 0700) == 0);
    int a = open("/tmp/links-a", O_DIRECTORY | O_RDONLY);
    int b = open("/tmp/links-b", O_DIRECTORY | O_RDONLY);
    assert(a >= 0 && b >= 0);
    int fd = openat(a, "source", O_CREAT | O_RDWR, 0751);
    assert(fd >= 0 && write(fd, "content", 7) == 7);
    close(fd);
    assert(bn_link_or_copy(a, "source", b, "dest", 0, -1, EPERM) == 0);
    fd = openat(b, "dest", O_RDONLY);
    char buf[8] = {0};
    assert(fd >= 0 && read(fd, buf, sizeof buf) == 7 && !strcmp(buf, "content"));
    struct stat src, dst;
    assert(!fstatat(a, "source", &src, 0) && !fstat(fd, &dst));
    assert((src.st_mode & 07777) == (dst.st_mode & 07777));
    close(fd);
    assert(bn_link_or_copy(a, "source", b, "dest", 0, -1, EPERM) == -1 && errno == EEXIST);
    assert(!symlinkat("source", a, "sym"));
    assert(bn_link_or_copy(a, "sym", b, "sym-copy", 0, -1, EPERM) == -1 && errno == EPERM);
    assert(bn_link_or_copy(a, "sym", b, "followed", AT_SYMLINK_FOLLOW, -1, EPERM) == 0);
    pid_t pid = fork();
    assert(pid >= 0);
    if (!pid) {
        struct rlimit limit = {1, 1};
        assert(!setrlimit(RLIMIT_FSIZE, &limit));
        signal(SIGXFSZ, SIG_IGN);
        assert(bn_link_or_copy(a, "source", b, "partial", 0, -1, EPERM) == -1 && errno == EFBIG);
        assert(fstatat(b, "partial", &dst, 0) == -1 && errno == ENOENT);
        _exit(0);
    }
    int status;
    assert(waitpid(pid, &status, 0) == pid && WIFEXITED(status) && WEXITSTATUS(status) == 0);
    close(a); close(b);
    puts("link fallback honors dirfds, symlinks, mode and EEXIST: OK");
}

static void check_fortified(void) {
    for (int test = 0; test < 4; test++) {
        pid_t pid = fork();
        assert(pid >= 0);
        if (pid == 0) {
            char buf[4];
            int fd = open("/dev/null", O_WRONLY);
            if (fd >= 0) { dup2(fd, STDERR_FILENO); close(fd); }
            if (test == 0) ((char *(*)(char *, size_t, size_t))dlsym(RTLD_DEFAULT, "__getcwd_chk"))(buf, 64, sizeof buf);
            if (test == 1) ((ssize_t (*)(const char *, char *, size_t, size_t))dlsym(RTLD_DEFAULT, "__readlink_chk"))("/proc/self/exe", buf, 64, sizeof buf);
            if (test == 2) ((ssize_t (*)(int, const char *, char *, size_t, size_t))dlsym(RTLD_DEFAULT, "__readlinkat_chk"))(AT_FDCWD, "/proc/self/exe", buf, 64, sizeof buf);
            if (test == 3) ((char *(*)(const char *, char *, size_t))dlsym(RTLD_DEFAULT, "__realpath_chk"))("/etc/group", buf, sizeof buf);
            _exit(1);
        }
        int status;
        assert(waitpid(pid, &status, 0) == pid && WIFSIGNALED(status) && WTERMSIG(status) == SIGABRT);
    }
    puts("fortified entry points reject undersized destinations: OK");
}

static void check_tcp_deadline(void) {
    for (int stalled = 0; stalled < 2; stalled++) {
        int server = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
        assert(server >= 0);
        struct sockaddr_in addr = {.sin_family = AF_INET, .sin_addr.s_addr = htonl(INADDR_LOOPBACK)};
        assert(!bind(server, (struct sockaddr *)&addr, sizeof addr) && !listen(server, 1));
        socklen_t size = sizeof addr;
        assert(!getsockname(server, (struct sockaddr *)&addr, &size));
        pid_t pid = fork();
        assert(pid >= 0);
        if (!pid) {
            int peer = accept(server, NULL, NULL);
            if (peer < 0) _exit(1);
            unsigned char query[14];
            size_t done = 0;
            while (done < sizeof query) {
                ssize_t n = read(peer, query + done, sizeof query - done);
                if (n <= 0) _exit(1);
                done += (size_t)n;
            }
            unsigned char reply[14] = {0, 12};
            if (send(peer, reply, 1, MSG_NOSIGNAL) != 1) _exit(1);
            usleep(stalled ? 500000 : 20000);
            if (send(peer, reply + 1, sizeof reply - 1, MSG_NOSIGNAL) != sizeof reply - 1) _exit(1);
            close(peer); close(server); _exit(0);
        }
        unsigned char query[12] = {0}, reply[32];
        int64_t start = bn_dns_now();
        int rc = bn_dns_tcp(&addr, query, sizeof query, reply, sizeof reply, stalled ? 60 : 500);
        if (stalled) {
            assert(rc < 0 && bn_dns_now() - start < 400);
            kill(pid, SIGTERM);
        } else assert(rc == 12);
        int status;
        assert(waitpid(pid, &status, 0) == pid);
        if (!stalled) assert(WIFEXITED(status) && WEXITSTATUS(status) == 0);
        close(server);
    }
    puts("DNS TCP fragmented prefix and stalled-peer deadline: OK");
}

// Mapping failures must stay failures even for creating or AT_EMPTY_PATH calls.
static void check_path_overflow(void) {
    const char *root = bn_rootfs();
    assert(root && *root);
    char buf[PATH_MAX], deep[PATH_MAX + 1];
    deep[0] = '/';
    memset(deep + 1, 'a', PATH_MAX - 1);
    deep[PATH_MAX] = '\0';
    const char *mapped = bn_map(deep, buf, sizeof buf);
    assert(mapped == bn_invalid_path && strlen(mapped) == PATH_MAX);
    assert(access(mapped, F_OK) == -1 && errno == ENAMETOOLONG);
    assert(open(mapped, O_CREAT | O_RDWR, 0600) == -1 && errno == ENAMETOOLONG);
    assert(mkdir(mapped, 0700) == -1 && errno == ENAMETOOLONG);
    struct stat st;
    assert(fstatat(AT_FDCWD, mapped, &st, AT_EMPTY_PATH) == -1 && errno == ENAMETOOLONG);
    // Even a short valid guest name cannot be returned unmodified when the
    // rootfs prefix does not fit the caller's output buffer.
    char tiny[2];
    assert(bn_map("/etc/group", tiny, sizeof tiny) == bn_invalid_path);
    assert(bn_map("/etc/group", tiny, 0) == bn_invalid_path);
    char *physical = malloc(strlen(root) + sizeof deep);
    assert(physical);
    strcpy(physical, root); strcat(physical, deep);
    assert(bn_unmap(physical, tiny, sizeof tiny) == bn_invalid_path);
    free(physical);
    assert(bn_resolve(AT_FDCWD, deep, buf, sizeof buf) == bn_invalid_path);
    char relative[PATH_MAX];
    memset(relative, 'a', sizeof relative - 1);
    memcpy(relative, "../", 3); relative[sizeof relative - 1] = '\0';
    char cwd[PATH_MAX];
    assert(bn_physical_cwd(cwd, sizeof cwd));
    assert(!chdir("/tmp"));
    assert(bn_resolve(AT_FDCWD, relative, buf, sizeof buf) == bn_invalid_path);
    assert(bn_map_symlink_target(relative, AT_FDCWD, "link", buf, sizeof buf) == bn_invalid_path);
    int (*real_chdir)(const char *) = dlsym(RTLD_NEXT, "chdir");
    assert(real_chdir && !real_chdir(cwd));
    puts("mapping overflow rejects lookup, creation and empty-path operations: OK");
}

// P1-5: the total budget, not resolv.conf's timeout, bounds a lookup.
static void check_dns_budget(void) {
    unsetenv("BIONILUX_DNS_BUDGET_MS");
    assert(bn_dns_budget_ms() == BN_DNS_BUDGET_DEFAULT_MS);
    assert(setenv("BIONILUX_DNS_BUDGET_MS", "250", 1) == 0);
    assert(bn_dns_budget_ms() == 250);
    // Hard ceiling, whatever the environment asks for.
    assert(setenv("BIONILUX_DNS_BUDGET_MS", "600000", 1) == 0);
    assert(bn_dns_budget_ms() == BN_DNS_BUDGET_MAX_MS);
    // Garbage keeps the default rather than disabling the budget.
    assert(setenv("BIONILUX_DNS_BUDGET_MS", "soon", 1) == 0);
    assert(bn_dns_budget_ms() == BN_DNS_BUDGET_DEFAULT_MS);
    assert(setenv("BIONILUX_DNS_BUDGET_MS", "0", 1) == 0);
    assert(bn_dns_budget_ms() == BN_DNS_BUDGET_DEFAULT_MS);
    assert(setenv("BIONILUX_DNS_BUDGET_MS", "250junk", 1) == 0);
    assert(bn_dns_budget_ms() == BN_DNS_BUDGET_DEFAULT_MS);
    assert(setenv("BIONILUX_DNS_BUDGET_MS", "99999999999999999999999999", 1) == 0);
    assert(bn_dns_budget_ms() == BN_DNS_BUDGET_MAX_MS);
    unsetenv("BIONILUX_DNS_BUDGET_MS");

    // A server that never answers: with a 5 s per-attempt timeout and 2
    // attempts, only the shared deadline keeps this quick.
    int server = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
    assert(server >= 0);
    struct sockaddr_in addr = {.sin_family = AF_INET, .sin_addr.s_addr = htonl(INADDR_LOOPBACK)};
    assert(!bind(server, (struct sockaddr *)&addr, sizeof addr));
    socklen_t size = sizeof addr;
    assert(!getsockname(server, (struct sockaddr *)&addr, &size));

    memset(&bn_dns, 0, sizeof bn_dns);
    bn_dns.server[0] = addr; bn_dns.server_count = 1;
    bn_dns.attempts = 2; bn_dns.timeout_ms = 5000; bn_dns.ndots = 1;
    bn_dns.search_count = 2;
    strcpy(bn_dns.search[0], "one.invalid");
    strcpy(bn_dns.search[1], "two.invalid");

    bn_answer answer;
    int64_t start = bn_dns_now();
    assert(bn_dns_query("tool", AF_INET, &answer, start + 200) == -2);
    assert(bn_dns_now() - start < 1000);
    close(server);
    puts("one total DNS budget bounds every attempt, server and search domain: OK");
}

// No nameserver must not fall through to unbounded host NSS resolution.
static void check_no_nameserver(void) {
    memset(&bn_dns, 0, sizeof bn_dns);
    bn_dns.check_countdown = 1 << 20;
    char nums[BN_DNS_MAXV4 + BN_DNS_MAXV6][INET6_ADDRSTRLEN];
    assert(bn_resolve_to_numeric("no-such-host.invalid", AF_INET, nums,
                               BN_DNS_MAXV4 + BN_DNS_MAXV6) == 0);
    struct addrinfo hints = {.ai_family = AF_INET, .ai_socktype = SOCK_STREAM};
    struct addrinfo *ours = NULL;
    assert(getaddrinfo("no-such-host.invalid", NULL, &hints, &ours) == EAI_NONAME);
    assert(!ours);
    assert(bn_resolve_to_numeric("bn-v6", AF_INET6, nums,
                               BN_DNS_MAXV4 + BN_DNS_MAXV6) == 1);
    assert(!strcmp(nums[0], "::1"));
    puts("no nameserver uses guest hosts or EAI_NONAME without host DNS: OK");
}

// P3-12: the minimal-environment context list must cover every variable the
// launcher exports as runtime configuration, or env -i style children lose it.
static void check_context_variables(void) {
    static const char *required[] = {
        "BIONILUX_ROOTFS=", "BIONILUX_PRELOAD=", "BIONILUX_LOADER=",
        "BIONILUX_NATIVE_LIB_DIR=", "BIONILUX_DNS_BUDGET_MS="
    };
    size_t count = sizeof bn_context / sizeof bn_context[0];
    for (size_t i = 0; i < sizeof required / sizeof required[0]; i++) {
        int found = 0;
        for (size_t k = 0; k < count; k++)
            if (!strcmp(bn_context[k].key, required[i])) found = 1;
        assert(found);
    }
    puts("minimal-environment context list covers the launcher's variables: OK");
}

// NULL envp and { NULL } both request an empty application environment, not
// loss of the private rootfs/loader transport which makes the child executable.
static void check_null_environment(void) {
    assert(!setenv("BIONILUX_DNS_BUDGET_MS", "123", 1));
    assert(!setenv("BN_SHOULD_NOT_LEAK", "host-value", 1));
    char *empty[] = {NULL};
    char **ev = strip_ld_preload(NULL), **explicit = strip_ld_preload(empty);
    assert(ev && explicit);
    size_t i = 0;
    for (; ev[i] && explicit[i]; i++) assert(!strcmp(ev[i], explicit[i]));
    assert(!ev[i] && !explicit[i]);
    assert(bn_env_has(ev, "BIONILUX_ROOTFS="));
    assert(bn_env_has(ev, "BIONILUX_DNS_BUDGET_MS="));
    assert(bn_env_has(ev, BN_ENV_KEEP));
    assert(!bn_env_has(ev, "BN_SHOULD_NOT_LEAK="));
    pid_t pid = fork();
    assert(pid >= 0);
    if (!pid) {
        environ = ev;
        on_init(); // Simulate caching transport before application startup.
        assert(!environ[0]);
        assert(bn_rootfs() && bn_dns_budget_ms() == 123);
        _exit(0);
    }
    int status;
    assert(waitpid(pid, &status, 0) == pid && WIFEXITED(status) && WEXITSTATUS(status) == 0);
    free(ev); free(explicit);
    unsetenv("BIONILUX_DNS_BUDGET_MS"); unsetenv("BN_SHOULD_NOT_LEAK");
    char *given[] = {"PATH=/usr/bin:/bin", "BIONILUX_TARGET_EXE=/usr/bin/bn-probe", NULL};
    ev = strip_ld_preload(given);
    assert(ev);
    int target_exe = 0;
    for (size_t k = 0; ev[k]; k++)
        if (!strncmp(ev[k], "BIONILUX_TARGET_EXE=", sizeof "BIONILUX_TARGET_EXE=" - 1)) target_exe++;
    assert(target_exe == 1);
    free(ev);
    puts("NULL environment keeps private context but restores empty application env: OK");
}

static void check_linker_arguments(void) {
    const char *path = "/data/app/backend/bin/bionilux";
    char *args[] = {"custom-or-empty-argv0", "/bin/bash", "-c", "id", NULL};
    char **av = bn_linker_argv("/system/bin/linker64", path, args);
    assert(av && !strcmp(av[0], "/system/bin/linker64") && av[1] == path);
    assert(!strcmp(av[2], "/bin/bash") && !strcmp(av[3], "-c") && !strcmp(av[4], "id") && !av[5]);
    free(av);
    av = bn_linker_argv("/system/bin/linker64", path, NULL);
    assert(av && av[1] == path && !av[2]);
    free(av);
    puts("system linker always loads the executable path, not arbitrary argv0: OK");
}

static void check_search(void) {
    int server = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
    assert(server >= 0);
    struct sockaddr_in addr = {.sin_family = AF_INET, .sin_addr.s_addr = htonl(INADDR_LOOPBACK)};
    assert(!bind(server, (struct sockaddr *)&addr, sizeof addr));
    socklen_t size = sizeof addr;
    assert(!getsockname(server, (struct sockaddr *)&addr, &size));
    pid_t pid = fork();
    assert(pid >= 0);
    if (!pid) {
        for (int i = 0; i < 2; i++) {
            unsigned char reply[512];
            struct sockaddr_in peer;
            socklen_t peer_size = sizeof peer;
            ssize_t n = recvfrom(server, reply, sizeof reply - 16, 0, (struct sockaddr *)&peer, &peer_size);
            if (n < 12) _exit(1);
            reply[2] = 0x81; reply[3] = i ? 0x80 : 0x83;
            reply[6] = 0; reply[7] = i ? 1 : 0;
            if (i) {
                const unsigned char answer[] = {0xc0,12,0,1,0,1,0,0,0,0,0,4,127,0,0,7};
                memcpy(reply + n, answer, sizeof answer); n += sizeof answer;
            }
            if (sendto(server, reply, (size_t)n, 0, (struct sockaddr *)&peer, peer_size) != n) _exit(1);
        }
        _exit(0);
    }
    memset(&bn_dns, 0, sizeof bn_dns);
    bn_dns.server[0] = addr; bn_dns.server_count = 1;
    bn_dns.attempts = 1; bn_dns.timeout_ms = 500; bn_dns.ndots = 1;
    bn_dns.search_count = 1; strcpy(bn_dns.search[0], "invalid");
    bn_answer answer;
    // The search list shares one deadline with the queries (P1-5).
    assert(!bn_dns_query("tool", AF_INET, &answer, bn_dns_now() + 5000));
    assert(answer.v4_count == 1 && ntohl(answer.v4[0].s_addr) == 0x7f000007);
    int status;
    assert(waitpid(pid, &status, 0) == pid && WIFEXITED(status) && WEXITSTATUS(status) == 0);
    close(server);
    FILE *fp = fopen("/etc/resolv.conf", "w");
    assert(fp); fputs("nameserver 127.0.0.2\noptions timeout:999999999999 attempts:999999 ndots:999999\n", fp); fclose(fp);
    bn_dns_load(1);
    // attempts is capped at 2, not at glibc's 5: one name is retried per server
    // and per search domain, so the old ceiling allowed a minutes-long stall.
    assert(bn_dns.server_count == 1 && bn_dns.timeout_ms == 30000 && bn_dns.attempts == 2 && bn_dns.ndots == 15);
    fp = fopen("/etc/resolv.conf", "w");
    assert(fp); fputs("nameserver 127.0.0.3\n", fp); fclose(fp);
    struct timespec times[] = {{2,0},{2,0}};
    assert(!utimensat(AT_FDCWD, "/etc/resolv.conf", times, 0));
    bn_dns_load(0);
    assert(ntohl(bn_dns.server[0].sin_addr.s_addr) == 0x7f000003);
    puts("DNS search NXDOMAIN continuation, config refresh and bounded options: OK");
}

int main(void) {
    check_tcp_deadline();
    check_path_overflow();
    check_dns_budget();
    check_context_variables();
    check_null_environment();
    check_linker_arguments();
    check_search();
    // Runs after check_search() so it needs no /etc/resolv.conf of its own.
    check_no_nameserver();
    check_link_fallback();
    check_fortified();
    unsigned char buf[520];
    char name[500];
    size_t o = 0;
    for (int i = 0; i < 7; i++) {
        memset(name + o, 'a', 63); o += 63; name[o++] = '.';
    }
    memset(name + o, 'b', 50); o += 50; name[o] = '\0';
    memset(buf, 0xa5, sizeof buf);
    assert(bn_dns_build(buf, 512, name, 42, 1) == -1);
    for (size_t i = 512; i < sizeof buf; i++) assert(buf[i] == 0xa5);
    assert(bn_dns_build(buf, 16, "a", 42, 1) == -1);
    assert(bn_dns_build(buf, 18, "a", 42, 1) == -1);
    assert(bn_dns_build(buf, 19, "a", 42, 1) == 19);
    // 255-byte encoded QNAME: 63.63.63.61 (including separators).
    o = 0;
    for (int i = 0; i < 4; i++) {
        size_t len = i == 3 ? 61 : 63;
        memset(name + o, 'c', len); o += len;
        name[o++] = i == 3 ? '\0' : '.';
    }
    assert(bn_dns_build(buf, sizeof buf, name, 42, 1) == 271);
    name[o - 1] = 'c'; name[o] = '\0';
    assert(bn_dns_build(buf, sizeof buf, name, 42, 1) == -1);
    puts("DNS wire capacity and QNAME bounds: OK");
    char *args[] = {"custom-argv0", "arg", NULL};
    const char *launcher;
    char **av, **ev;
    assert(reroute(1, "bn-tool", args, environ, &launcher, &av, &ev) == 1);
    assert(!strcmp(av[4], "/usr/bin/bn-tool"));
    assert((char *)av[4] >= (char *)av && (char *)av[4] < (char *)av + 256);
    free(av); free(ev);
    puts("reroute owns resolved target: OK");
    return 0;
}
