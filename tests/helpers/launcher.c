// Native hook-test launcher, not an Android or Rust-launcher substitute.
#define _GNU_SOURCE
#include <assert.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
    int i = 1;
    const char *arg0 = NULL;
    if (i < argc && !strcmp(argv[i], "--rootfs")) i += 2;
    if (i < argc && !strcmp(argv[i], "--argv0")) { arg0 = argv[i + 1]; i += 2; }
    if (i < argc && !strcmp(argv[i], "--")) i++;
    assert(i < argc);
    char physical[PATH_MAX];
    const char *root = getenv("BIONILUX_ROOTFS");
    const char *target = argv[i];
    if (target[0] == '/' && strncmp(target, root, strlen(root))) {
        assert(snprintf(physical, sizeof physical, "%s%s", root, target) < (int)sizeof physical);
        target = physical;
    }
    if (arg0) argv[i] = (char *)arg0;
    assert(setenv("LD_PRELOAD", getenv("BIONILUX_PRELOAD"), 1) == 0);
    unsetenv("BIONILUX_INTERNAL_PRELOAD");
    execv(target, argv + i);
    perror(target);
    return 127;
}
