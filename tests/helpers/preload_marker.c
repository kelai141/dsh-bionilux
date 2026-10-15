#include <stdlib.h>
#include <unistd.h>

__attribute__((constructor)) static void loaded(void) {
    if (getenv("BN_PRELOAD_MARKER")) {
        const char marker[] = "preload-marker\n";
        if (write(STDOUT_FILENO, marker, sizeof marker - 1) != sizeof marker - 1) _exit(1);
    }
}
