// fexecve() on the helper's own binary. Using /proc/self/exe would point to
// ld.so under bionilux, not the helper (the kernel sees ld.so as executable).
// Prints "fexecve-ok" if the reroute chain works.
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>

int main(int argc, char **argv) {
    // Second invocation (with --yes) prints the marker and exits.
    if (argc > 1 && argv[1][0] == '-' && argv[1][1] == '-') {
        puts("fexecve-ok");
        return 0;
    }

    int fd = open(argv[0], O_RDONLY);
    if (fd < 0) { perror("open"); return 1; }

    char *nargv[] = { argv[0], "--yes", NULL };
    fexecve(fd, nargv, NULL);
    perror("fexecve");
    return 1;
}