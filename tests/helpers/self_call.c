// Calls the bionilux launcher via execve/execvp/posix_spawn from a glibc
// process. The launcher is bionic and must not inherit LD_PRELOAD, so this
// catches missing strip logic. Prints "self-ok" if the launcher ran bash -c.
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

#define GLIBC "/data/data/com.termux/files/usr/glibc"

// The launcher sets BIONILUX_BINARY_PATH in every glibc child it starts.
// The hook compares against the same string, so we reuse it here.
static const char *bionilux_path(void) {
    const char *p = getenv("BIONILUX_BINARY_PATH");
    if (!p || !*p) {
        fprintf(stderr, "self_call: BIONILUX_BINARY_PATH not set "
                        "(run under bionilux)\n");
        exit(2);
    }
    return p;
}

static void try_execve(void) {
    char *argv[] = { (char *)bionilux_path(),
                     GLIBC "/bin/bash", "-c", "echo self-ok", NULL };
    execve(argv[0], argv, environ);
    perror("execve");
}

static void try_execvp(void) {
    char *argv[] = { (char *)bionilux_path(),
                     GLIBC "/bin/bash", "-c", "echo self-ok", NULL };
    execvp(argv[0], argv);
    perror("execvp");
}

static void try_posix_spawn(void) {
    char *argv[] = { (char *)bionilux_path(),
                     GLIBC "/bin/bash", "-c", "echo self-ok", NULL };
    pid_t pid;
    int rc = posix_spawn(&pid, argv[0], NULL, NULL, argv, environ);
    if (rc != 0) {
        fprintf(stderr, "posix_spawn: %s\n", strerror(rc));
        exit(1);
    }
    int status;
    while (waitpid(pid, &status, 0) < 0) {
        if (errno == EINTR) continue;
        perror("waitpid");
        exit(1);
    }
    if (WIFEXITED(status)) exit(WEXITSTATUS(status));
    if (WIFSIGNALED(status)) exit(128 + WTERMSIG(status));
    exit(1);
}

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: %s execve|execvp|posix_spawn\n", argv[0]);
        return 2;
    }
    if (strcmp(argv[1], "execve") == 0)            try_execve();
    else if (strcmp(argv[1], "execvp") == 0)       try_execvp();
    else if (strcmp(argv[1], "posix_spawn") == 0)  try_posix_spawn();
    else return 2;
    return 1;
}