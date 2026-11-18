#define _GNU_SOURCE
#include <arpa/inet.h>
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>

static void reject_old_accept(void) {
    struct sock_filter rules[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_accept, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog program = { .len = sizeof rules / sizeof *rules, .filter = rules };
    assert(prctl(PR_SET_NO_NEW_PRIVS, 1L, 0L, 0L, 0L) == 0);
    assert(prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program) == 0);
}

int main(int argc, char **argv) {
    if (argc == 2 && strcmp(argv[1], "deny-accept") == 0) reject_old_accept();

    int listener = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
    assert(listener >= 0);
    struct sockaddr_in address = { .sin_family = AF_INET, .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
    socklen_t length = sizeof address;
    assert(bind(listener, (struct sockaddr *)&address, length) == 0);
    assert(getsockname(listener, (struct sockaddr *)&address, &length) == 0);
    assert(listen(listener, 1) == 0);
    int empty = accept(listener, NULL, NULL);
    if (empty == -1 && errno == ENOSYS) return 77;
    assert(empty == -1 && (errno == EAGAIN || errno == EWOULDBLOCK));

    int client = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
    assert(client >= 0 && connect(client, (struct sockaddr *)&address, length) == 0);
    struct sockaddr_in peer;
    length = sizeof peer;
    int connection = accept(listener, (struct sockaddr *)&peer, &length);
    assert(connection >= 0 && length == sizeof peer && peer.sin_family == AF_INET);
    int descriptor_flags = fcntl(connection, F_GETFD);
    int status_flags = fcntl(connection, F_GETFL);
    assert(descriptor_flags >= 0 && !(descriptor_flags & FD_CLOEXEC));
    assert(status_flags >= 0 && !(status_flags & O_NONBLOCK));
    assert(write(client, "x", 1) == 1);
    char byte;
    assert(read(connection, &byte, 1) == 1 && byte == 'x');
    return 0;
}
