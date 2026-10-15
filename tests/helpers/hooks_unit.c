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
    assert(!bn_dns_query("tool", AF_INET, &answer));
    assert(answer.v4_count == 1 && ntohl(answer.v4[0].s_addr) == 0x7f000007);
    int status;
    assert(waitpid(pid, &status, 0) == pid && WIFEXITED(status) && WEXITSTATUS(status) == 0);
    close(server);
    FILE *fp = fopen("/etc/resolv.conf", "w");
    assert(fp); fputs("nameserver 127.0.0.2\noptions timeout:999999999999 attempts:999999 ndots:999999\n", fp); fclose(fp);
    bn_dns_load(1);
    assert(bn_dns.server_count == 1 && bn_dns.timeout_ms == 30000 && bn_dns.attempts == 5 && bn_dns.ndots == 15);
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
    check_search();
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
