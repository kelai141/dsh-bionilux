#define _GNU_SOURCE
#include <limits.h>
#include <assert.h>
#include <errno.h>
#include <grp.h>
#include <netdb.h>
#include <spawn.h>
#include <pthread.h>
#include <fcntl.h>
#include <signal.h>
#include <stdatomic.h>
#include <sys/ioctl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

static void check_group(void) {
    struct group gr, *out;
    union { char buf[256]; void *align; } b;
    memset(&b, 0xa5, sizeof b);
    assert(getgrnam_r("bn-group", &gr, b.buf + 1, sizeof b.buf - 1, &out) == 0);
    assert(out == &gr && gr.gr_gid == 4242);
    assert((size_t)gr.gr_mem % _Alignof(char *) == 0);
    assert(gr.gr_mem[0] && !strcmp(gr.gr_mem[0], "alice"));
    assert(gr.gr_mem[1] && !strcmp(gr.gr_mem[1], "bob"));
    assert(!gr.gr_mem[2]);
    for (size_t n = 0; n < 64; n++) {
        unsigned char small[80];
        memset(small, 0xa5, sizeof small);
        int rc = getgrnam_r("bn-group", &gr, (char *)small + 1, n, &out);
        assert(rc == ERANGE || rc == 0);
        assert(small[0] == 0xa5 && small[n + 1] == 0xa5);
    }
    puts("group members, alignment and small buffers: OK");
}

static void check_hosts(void) {
    struct hostent *host = gethostbyname2("bn-v6", AF_INET6);
    assert(host && host->h_addrtype == AF_INET6 && host->h_length == 16);
    struct hostent entry, *out;
    int error = 0;
    char buf[2048];
    assert(gethostbyname2_r("bn-v6", AF_INET6, &entry, buf, sizeof buf, &out, &error) == 0);
    assert(out && out->h_addrtype == AF_INET6);
    puts("IPv6 gethostbyname2 ABI: OK");
}

static void check_spawn(void) {
    pid_t pid;
    char *args[] = {"bn-missing-unique", NULL};
    int rc = posix_spawnp(&pid, args[0], NULL, NULL, args, environ);
    assert(rc == ENOENT);
    rc = posix_spawn(&pid, "/bn-no-executable", NULL, NULL, args, environ);
    assert(rc == EACCES);
    const char *scripts[] = {"/usr/bin/bn-missing-interpreter", "/usr/bin/bn-denied-interpreter", "/usr/bin/bn-loop"};
    const int errors[] = {ENOENT, EACCES, ELOOP};
    for (int i = 0; i < 3; i++) {
        assert(execve(scripts[i], args, environ) == -1 && errno == errors[i]);
        pid = -1;
        assert(posix_spawn(&pid, scripts[i], NULL, NULL, args, environ) == errors[i] && pid == -1);
    }
    puts("spawn and shebang-interpreter error-number contract: OK");
}

static void *process_thread(void *unused) {
    (void)unused;
    for (int i = 0; i < 20; i++) {
        FILE *fp = popen("printf guest-output; exit 7", "re");
        assert(fp && (fcntl(fileno(fp), F_GETFD) & FD_CLOEXEC));
        char buf[64];
        assert(fgets(buf, sizeof buf, fp) && !strcmp(buf, "guest-output"));
        int status = pclose(fp);
        assert(WIFEXITED(status) && WEXITSTATUS(status) == 7);
    }
    return NULL;
}

static void *cancelled_system(void *unused) {
    (void)unused;
    int status = system("exec /bin/sleep 30");
    assert(status != -1);
    return NULL;
}

static void noop(int signal_number) { (void)signal_number; }

static void check_process(void) {
    errno = 0;
    assert(!popen("true", "invalid") && errno == EINVAL);
    FILE *streams[40];
    for (int i = 0; i < 40; i++) {
        streams[i] = popen("exit 7", "r");
        assert(streams[i]);
    }
    for (int i = 39; i >= 0; i--) {
        int status = pclose(streams[i]);
        assert(WIFEXITED(status) && WEXITSTATUS(status) == 7);
    }
    pthread_t threads[4];
    for (int i = 0; i < 4; i++) assert(!pthread_create(&threads[i], NULL, process_thread, NULL));
    for (int i = 0; i < 4; i++) assert(!pthread_join(threads[i], NULL));
    struct sigaction action = {.sa_handler = noop}, old, after;
    sigemptyset(&action.sa_mask);
    assert(!sigaction(SIGINT, &action, &old));
    int status = system("exit 7");
    assert(WIFEXITED(status) && WEXITSTATUS(status) == 7);
    assert(!sigaction(SIGINT, NULL, &after) && after.sa_handler == noop);
    pthread_t cancelled;
    assert(!pthread_create(&cancelled, NULL, cancelled_system, NULL));
    usleep(200000);
    assert(!pthread_cancel(cancelled));
    void *result;
    assert(!pthread_join(cancelled, &result) && result == PTHREAD_CANCELED);
    assert(!sigaction(SIGINT, NULL, &after) && after.sa_handler == noop);
    assert(!sigaction(SIGINT, &old, NULL));
    assert(!sigaction(SIGALRM, &action, &old));
    FILE *fp = popen("/bin/sleep 2; exit 9", "r");
    assert(fp);
    alarm(1);
    status = pclose(fp);
    alarm(0);
    assert(WIFEXITED(status) && WEXITSTATUS(status) == 9);
    assert(!sigaction(SIGALRM, &old, NULL));
    puts("popen concurrency, >32 streams, EINTR and system signals: OK");
}

static void check_temporary(void) {
    char invalid[] = "/tmp/bn-XXXXXX";
    assert(mkstemps(invalid, -1) == -1 && errno == EINVAL);
    char file[] = "/tmp/bn-XXXXXX.suffix";
    int fd = mkostemps(file, 7, O_CLOEXEC);
    assert(fd >= 0 && !strstr(file, "XXXXXX") && (fcntl(fd, F_GETFD) & FD_CLOEXEC));
    close(fd);
    assert(!unlink(file));
    char dir[] = "/tmp/bn-XXXXXX";
    assert(mkdtemp(dir) == dir && !strstr(dir, "XXXXXX"));
    assert(!rmdir(dir));
    puts("temporary files preserve suffix and flags: OK");
}

static void check_readlink(void) {
    assert(!symlink("/etc/group", "/tmp/bn-link"));
    char buf[4] = {0};
    assert(readlink("/tmp/bn-link", buf, 3) == 3 && !memcmp(buf, "/et", 3));
    assert(readlink("/tmp/bn-link", buf, 0) == -1 && errno == EINVAL);
    assert(!unlink("/tmp/bn-link"));
    int fd = open("/tmp/bn-file", O_CREAT | O_WRONLY, 0600);
    assert(fd >= 0); close(fd);
    assert(open("/tmp/bn-file/", O_RDONLY) == -1 && errno == ENOTDIR);
    assert(open("/tmp/bn-file/.", O_RDONLY) == -1 && errno == ENOTDIR);
    assert(!unlink("/tmp/bn-file"));
    puts("readlink truncates logical rather than physical paths: OK");
}

static void check_exec(void) {
    for (int test = 0; test < 15; test++) {
        pid_t pid = fork();
        assert(pid >= 0);
        if (!pid) {
            char *args[] = {"custom-argv0", "argv0", NULL};
            if (test == 0) execvp("bn-probe", args);
            if (test == 1) {
                size_t count = 0;
                while (environ[count]) count++;
                char **env = calloc(count + 1, sizeof *env);
                assert(env);
                for (size_t i = 0; i < count; i++)
                    env[i] = strncmp(environ[i], "PATH=", 5) ? environ[i] : "PATH=/bn-missing-path";
                execvpe("bn-probe", args, env);
            }
            if (test == 2) {
                pid_t child;
                assert(!posix_spawnp(&child, "bn-probe", NULL, NULL, args, environ));
                int status;
                assert(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0);
                _exit(0);
            }
            if (test >= 3 && test <= 5) {
                assert(!chdir("/tmp"));
                assert(!setenv("PATH", test == 3 ? ":/bn-missing" : test == 4 ? "/bn-missing:" : "", 1));
                execvp("local-probe", args);
            }
            if (test == 6) {
                assert(!chdir("/tmp"));
                assert(execve("bn-probe", args, environ) == -1 && errno == ENOENT);
                pid_t child;
                assert(posix_spawn(&child, "bn-probe", NULL, NULL, args, environ) == ENOENT);
                _exit(0);
            }
            if (test == 7) execvp("bn-text", args);
            if (test == 8) {
                assert(execve("/usr/bin/bn-text", args, environ) == -1 && errno == ENOEXEC);
                pid_t child;
                assert(posix_spawnp(&child, "bn-text", NULL, NULL, args, environ) == ENOEXEC);
                _exit(0);
            }
            if (test == 9) {
                char *minimal[] = {"PATH=/usr/bin:/bin", NULL};
                args[1] = "minimal-env";
                execve("/usr/bin/bn-probe", args, minimal);
            }
            if (test == 10) {
                char *env_args[] = {"env", "-i", "/usr/bin/bn-probe", "minimal-env", NULL};
                execve("/usr/bin/env", env_args, environ);
            }
            if (test == 14) {
                char *minimal[] = {"PATH=/usr/bin:/bin", "SSL_CERT_FILE=/explicit.pem",
                                   "LOCPATH=/explicit-locales", "CUSTOM_KEEP=a:b=c", NULL};
                args[1] = "minimal-env";
                execve("/usr/bin/bn-probe", args, minimal);
            }
            if (test == 11) {
                int dir = open("/usr/bin", O_RDONLY | O_DIRECTORY);
                assert(dir >= 0);
                execveat(dir, "bn-probe", args, environ, 0);
            }
            if (test == 12) {
                assert(execveat(AT_FDCWD, "/usr/bin/bn-probe", args, environ, 0x10000000) == -1 && errno == EINVAL);
                assert(symlink("/usr/bin/bn-probe", "/tmp/bn-probe-link") == 0);
                assert(execveat(AT_FDCWD, "/tmp/bn-probe-link", args, environ, AT_SYMLINK_NOFOLLOW) == -1 && errno == ELOOP);
                assert(!unlink("/tmp/bn-probe-link"));
                _exit(0);
            }
            if (test == 13) {
                int fd = open("/usr/bin/bn-probe", O_RDONLY | O_CLOEXEC);
                assert(fd >= 0);
                execveat(fd, "", args, environ, AT_EMPTY_PATH);
            }
            perror("exec test");
            _exit(1);
        }
        int status;
        assert(waitpid(pid, &status, 0) == pid && WIFEXITED(status) && WEXITSTATUS(status) == (test == 7 ? 23 : 0));
    }
    puts("exec/spawn argv0, explicit paths, caller PATH and empty PATH entries: OK");
}

struct closing_pipe { FILE *stream; atomic_int done; int status; };

static void *close_writer(void *arg) {
    struct closing_pipe *state = arg;
    state->status = pclose(state->stream);
    atomic_store(&state->done, 1);
    return NULL;
}

static void check_pclose_race(void) {
    int drain[2], hold[2];
    assert(!pipe(drain) && !pipe(hold));
    char number[32];
    snprintf(number, sizeof number, "%d", drain[0]);
    assert(!setenv("BN_DRAIN_FD", number, 1));
    snprintf(number, sizeof number, "%d", hold[0]);
    assert(!setenv("BN_HOLD_FD", number, 1));
    FILE *writer = popen("exec /usr/bin/bn-probe drain", "w");
    assert(writer);
    int fd = fileno(writer);
    int capacity = fcntl(fd, F_GETPIPE_SZ);
    assert(capacity > 0);
    size_t size = (size_t)capacity * 2;
    char *buffer = malloc(size);
    char *data = malloc(size - 1);
    assert(buffer && data);
    memset(data, 'x', size - 1);
    assert(!setvbuf(writer, buffer, _IOFBF, size));
    assert(fwrite(data, 1, size - 1, writer) == size - 1);
    struct closing_pipe state = {.stream = writer};
    pthread_t thread;
    assert(!pthread_create(&thread, NULL, close_writer, &state));
    int pending = 0;
    for (int i = 0; i < 500 && !pending; i++) {
        assert(!ioctl(fd, FIONREAD, &pending));
        if (!pending) usleep(1000);
    }
    assert(pending > 0 && !atomic_load(&state.done));
    FILE *second = popen("exec /usr/bin/bn-probe hold", "r");
    assert(second);
    char ready[32];
    assert(fgets(ready, sizeof ready, second) && !strcmp(ready, "hold-ready\n"));
    assert(write(drain[1], "x", 1) == 1);
    for (int i = 0; i < 1000 && !atomic_load(&state.done); i++) usleep(1000);
    int finished_without_second_exit = atomic_load(&state.done);
    assert(write(hold[1], "x", 1) == 1);
    assert(!pclose(second));
    assert(!pthread_join(thread, NULL));
    assert(!state.status && finished_without_second_exit);
    close(drain[0]); close(drain[1]); close(hold[0]); close(hold[1]);
    free(buffer); free(data);
    puts("blocked write-pclose does not leak its writer into concurrent popen: OK");
}

static void check_path_interpreters(void) {
    for (int test = 0; test < 6; test++) {
        pid_t pid = fork();
        assert(pid >= 0);
        if (!pid) {
            assert(!setenv("PATH", "/first:/second", 1));
            char *name = test < 3 ? "tool" : "denied-tool";
            char *args[] = {"custom-argv0", "argv0", NULL};
            if (test % 3 == 0) execvp(name, args);
            if (test % 3 == 1) execvpe(name, args, environ);
            if (test % 3 == 2) {
                pid_t child;
                assert(!posix_spawnp(&child, name, NULL, NULL, args, environ));
                int status;
                assert(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0);
                _exit(0);
            }
            _exit(1);
        }
        int status;
        assert(waitpid(pid, &status, 0) == pid && WIFEXITED(status) && WEXITSTATUS(status) == 0);
    }
    assert(!setenv("PATH", "/first:/second", 1));
    char *args[] = {"all-denied", NULL};
    assert(execvp("all-denied", args) == -1 && errno == EACCES);
    pid_t pid = -1;
    assert(posix_spawnp(&pid, "all-denied", NULL, NULL, args, environ) == EACCES && pid == -1);
    assert(execvp("missing-only", args) == -1 && errno == ENOENT);
    puts("PATH skips missing/denied interpreters and preserves final EACCES: OK");
}

int main(int argc, char **argv) {
    assert(argc == 2);
    if (!strcmp(argv[1], "group")) check_group();
    else if (!strcmp(argv[1], "hosts")) check_hosts();
    else if (!strcmp(argv[1], "spawn")) check_spawn();
    else if (!strcmp(argv[1], "process")) check_process();
    else if (!strcmp(argv[1], "pclose-race")) check_pclose_race();
    else if (!strcmp(argv[1], "drain")) {
        char control, data[4096];
        assert(read(atoi(getenv("BN_DRAIN_FD")), &control, 1) == 1);
        ssize_t n;
        do { n = read(STDIN_FILENO, data, sizeof data); } while (n > 0);
        assert(n == 0);
    }
    else if (!strcmp(argv[1], "hold")) {
        char control;
        puts("hold-ready"); assert(!fflush(stdout));
        assert(read(atoi(getenv("BN_HOLD_FD")), &control, 1) == 1);
    }
    else if (!strcmp(argv[1], "temporary")) check_temporary();
    else if (!strcmp(argv[1], "readlink")) check_readlink();
    else if (!strcmp(argv[1], "exec")) check_exec();
    else if (!strcmp(argv[1], "path-interpreters")) check_path_interpreters();
    else if (!strcmp(argv[1], "workspace")) {
        const char *workspace = getenv("BN_TEST_WORKSPACE");
        assert(workspace && !chdir(workspace));
        int fd = open("../workspace/marker", O_RDONLY);
        char buf[32] = {0};
        assert(fd >= 0 && read(fd, buf, sizeof buf) == 14 && !strcmp(buf, "host-workspace"));
        close(fd);
        puts("relative dotdot keeps exposed host workspace semantics: OK");
    }
    else if (!strcmp(argv[1], "argv0")) assert(!strcmp(argv[0], "custom-argv0"));
    else if (!strcmp(argv[1], "minimal-env") || !strcmp(argv[1], "minimal-grandchild")) {
        assert(!getenv("HOME"));
        assert(!getenv("BIONILUX_ROOTFS") && !getenv("BIONILUX_BINARY_PATH"));
        assert(!getenv("BIONILUX_TARGET_EXE") && !getenv("BIONILUX_GUEST_SESSION"));
        assert(!getenv("LD_PRELOAD") && !getenv("BIONILUX_INTERNAL_ENV_KEEP"));
        assert(!getenv("BIONILUX_PROCESS_SCOPE"));
        int environment_fd = open("/proc/self/environ", O_RDONLY);
        assert(environment_fd >= 0);
        char environment[16384];
        ssize_t environment_len = read(environment_fd, environment, sizeof environment);
        assert(environment_len > 0); close(environment_fd);
        const char scope[] = "BIONILUX_PROCESS_SCOPE=bn-scope-fixture";
        assert(memmem(environment, (size_t)environment_len, scope, sizeof scope));
        if (getenv("CUSTOM_KEEP")) {
            assert(!strcmp(getenv("CUSTOM_KEEP"), "a:b=c"));
            assert(!strcmp(getenv("SSL_CERT_FILE"), "/explicit.pem"));
            assert(!strcmp(getenv("LOCPATH"), "/explicit-locales"));
        } else {
            assert(!getenv("SSL_CERT_FILE") && !getenv("SSL_CERT_DIR") && !getenv("LOCPATH"));
        }
        int fd = open("/usr/bin/bn-tool", O_RDONLY);
        assert(fd >= 0); close(fd); // The private rootfs context still works.
        char self[PATH_MAX];
        ssize_t self_len = readlink("/proc/self/exe", self, sizeof self - 1);
        assert(self_len > 0); self[self_len] = 0;
        assert(!strcmp(self, "/usr/bin/bn-probe"));
        char *canonical = realpath("/proc/self/exe", NULL);
        assert(canonical && !strcmp(canonical, "/usr/bin/bn-probe")); free(canonical);
        if (!strcmp(argv[1], "minimal-env")) {
            char *args[] = {"bn-probe", "minimal-grandchild", NULL};
            execve("/usr/bin/bn-probe", args, environ);
            abort();
        }
    }
    else if (!strcmp(argv[1], "preload")) {
        pid_t pid = fork();
        assert(pid >= 0);
        if (!pid) {
            char *args[] = {"bn-probe", "success", NULL};
            execvp("bn-probe", args); _exit(1);
        }
        int status;
        assert(waitpid(pid, &status, 0) == pid && WIFEXITED(status) && WEXITSTATUS(status) == 0);
    }
    else if (!strcmp(argv[1], "success")) return 0;
    else if (!strcmp(argv[1], "jobserver")) {
        const char *flags = getenv("MAKEFLAGS");
        assert(flags);
        const char *auth = strstr(flags, "--jobserver-auth=");
        if (!auth) auth = strstr(flags, "--jobserver-fds=");
        assert(auth);
        int a, b;
        assert(sscanf(strchr(auth, '=') + 1, "%d,%d", &a, &b) == 2);
        assert(fcntl(a, F_GETFD) >= 0 && fcntl(b, F_GETFD) >= 0);
    }
    else abort();
    return 0;
}
