// ftsprobe — what fts(3) sees behind the launcher's preload.
//
// find(1) and rm -rf both build their traversal on fts(3). glibc implements
// fts inside libc.so.6, so the stat()/opendir() calls fts makes internally do
// not cross the PLT and cannot be interposed: each one resolves an absolute
// path against the host instead of the guest rootfs. This probe walks a tree
// with the same calls and reports the entry it could not read, which is what
// localises the failure.
//
//   gcc -O2 -o ftsprobe ftsprobe.c
//   ./ftsprobe /root/KernelSU          # FTS_PHYSICAL | FTS_NOSTAT
//   ./ftsprobe /root/KernelSU nochdir  # add FTS_NOCHDIR
//   ./ftsprobe /root/KernelSU stat     # drop FTS_NOSTAT
//   ./ftsprobe /root/KernelSU logical  # FTS_LOGICAL

#include <fts.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>

static const char *fts_info_name(int info) {
    switch (info) {
        case FTS_D: return "D";
        case FTS_DC: return "DC";
        case FTS_DEFAULT: return "DEFAULT";
        case FTS_DNR: return "DNR";
        case FTS_DOT: return "DOT";
        case FTS_DP: return "DP";
        case FTS_ERR: return "ERR";
        case FTS_F: return "F";
        case FTS_INIT: return "INIT";
        case FTS_NS: return "NS";
        case FTS_NSOK: return "NSOK";
        case FTS_SL: return "SL";
        case FTS_SLNONE: return "SLNONE";
        case FTS_W: return "W";
        default: return "?";
    }
}

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: %s PATH [nochdir|stat|logical]\n", argv[0]);
        return 2;
    }

    int options = FTS_PHYSICAL | FTS_NOSTAT;
    for (int i = 2; i < argc; i++) {
        if (strcmp(argv[i], "nochdir") == 0) options |= FTS_NOCHDIR;
        else if (strcmp(argv[i], "stat") == 0) options &= ~FTS_NOSTAT;
        else if (strcmp(argv[i], "logical") == 0) {
            options &= ~FTS_PHYSICAL;
            options |= FTS_LOGICAL;
        } else {
            fprintf(stderr, "unknown option: %s\n", argv[i]);
            return 2;
        }
    }

    char *paths[2] = { argv[1], NULL };
    FTS *fts = fts_open(paths, options, NULL);
    if (!fts) {
        fprintf(stderr, "fts_open: %s (errno=%d)\n", strerror(errno), errno);
        return 1;
    }

    printf("options=%s%s%s%s\n", (options & FTS_NOCHDIR) ? "NOCHDIR " : "",
           (options & FTS_NOSTAT) ? "NOSTAT " : "",
           (options & FTS_LOGICAL) ? "LOGICAL " : "PHYSICAL ", "");

    unsigned count = 0;
    FTSENT *e;
    errno = 0;
    while ((e = fts_read(fts)) != NULL) {
        count++;
        // FTS_INIT is the synthetic root of the traversal and is not reported
        // by find, so it is not counted here either.
        if (e->fts_info == FTS_INIT) {
            count--;
            continue;
        }
        printf("  [%u] level=%d info=%s errno=%d path=%s accpath=%s\n", count,
               e->fts_level, fts_info_name(e->fts_info), e->fts_errno,
               e->fts_path, e->fts_accpath);
    }

    printf("entries=%u\n", count);
    if (errno) printf("fts_read stopped: %s (errno=%d)\n", strerror(errno), errno);
    printf("fts_close=%d\n", fts_close(fts));
    return errno ? 1 : 0;
}
