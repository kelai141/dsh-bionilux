/* glob()/glob64() regression probe for the bionilux preload.
 *
 * Prints stable KEY TAG VALUE lines; tests/glob_compat.sh asserts them.
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <glob.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int error_calls;

static int error_fn(const char *path, int error) {
    printf("ERRPATH %s\n", path);
    printf("ERRNO %d\n", error);
    error_calls++;
    return 0;
}

static void dump(const char *tag, int rc, glob_t *g) {
    printf("RC %s %d\n", tag, rc);
    printf("COUNT %s %zu\n", tag, rc == 0 ? g->gl_pathc : 0);
    printf("ALT %s %s\n", tag, (g->gl_flags & GLOB_ALTDIRFUNC) ? "yes" : "no");
    if (rc == 0) {
        size_t total = g->gl_pathc + g->gl_offs;
        for (size_t i = 0; i < total; i++)
            printf("ENTRY %s %zu %s\n", tag, i,
                   g->gl_pathv[i] ? g->gl_pathv[i] : "(null)");
    }
}

static void *custom_opendir(const char *path) {
    static int calls;
    calls++;
    printf("CUSTOM_OPENDIR %d\n", calls);
    return opendir(path);
}

static struct dirent *custom_readdir(void *dir) {
    return readdir((DIR *)dir);
}

static void custom_closedir(void *dir) {
    closedir((DIR *)dir);
}

static int custom_stat(const char *path, struct stat *st) {
    static int calls;
    calls++;
    printf("CUSTOM_STAT %d\n", calls);
    return stat(path, st);
}

static int custom_lstat(const char *path, struct stat *st) {
    static int calls;
    calls++;
    printf("CUSTOM_LSTAT %d\n", calls);
    return lstat(path, st);
}

int main(int argc, char **argv) {
    if (argc < 3) {
        fprintf(stderr, "usage: glob_compat MODE PATTERN [DIR]\n");
        return 2;
    }
    const char *mode = argv[1];
    const char *pattern = argv[2];
    glob_t g;
    memset(&g, 0, sizeof g);
    int rc;

    if (strcmp(mode, "abs") == 0 || strcmp(mode, "physical") == 0) {
        rc = glob(pattern, 0, NULL, &g);
        dump("abs", rc, &g);
        globfree(&g);
        return 0;
    }

    if (strcmp(mode, "rel") == 0) {
        if (argc < 4) return 2;
        if (chdir(pattern) != 0) {
            printf("CHDIR %d\n", errno);
            return 1;
        }
        rc = glob(argv[3], 0, NULL, &g);
        dump("rel", rc, &g);
        globfree(&g);
        return 0;
    }

    if (strcmp(mode, "nocheck") == 0) {
        rc = glob(pattern, GLOB_NOCHECK, NULL, &g);
        dump("nocheck", rc, &g);
        globfree(&g);
        return 0;
    }

    if (strcmp(mode, "dooffs") == 0) {
        g.gl_offs = 2;
        rc = glob(pattern, GLOB_DOOFFS, NULL, &g);
        dump("dooffs", rc, &g);
        globfree(&g);
        return 0;
    }

    if (strcmp(mode, "append") == 0) {
        char first[4096], second[4096];
        snprintf(first, sizeof first, "%sa*", pattern);
        snprintf(second, sizeof second, "%sb*", pattern);
        rc = glob(first, 0, NULL, &g);
        if (rc != 0) {
            printf("RC append-first %d\n", rc);
            return 1;
        }
        rc = glob(second, GLOB_APPEND, NULL, &g);
        dump("append", rc, &g);
        globfree(&g);
        return 0;
    }

    if (strcmp(mode, "altdir") == 0) {
        g.gl_opendir = custom_opendir;
        g.gl_readdir = custom_readdir;
        g.gl_closedir = custom_closedir;
        g.gl_stat = custom_stat;
        g.gl_lstat = custom_lstat;
        rc = glob(pattern, GLOB_ALTDIRFUNC, NULL, &g);
        dump("altdir", rc, &g);
        globfree(&g);
        return 0;
    }

    if (strcmp(mode, "errfunc") == 0) {
        rc = glob(pattern, GLOB_ERR, error_fn, &g);
        printf("ERRCOUNT %d\n", error_calls);
        dump("errfunc", rc, &g);
        globfree(&g);
        return 0;
    }

    if (strcmp(mode, "glob64") == 0) {
        glob64_t g64;
        memset(&g64, 0, sizeof g64);
        int rc64 = glob64(pattern, 0, NULL, &g64);
        printf("RC glob64 %d\n", rc64);
        printf("COUNT glob64 %zu\n", rc64 == 0 ? g64.gl_pathc : 0);
        if (rc64 == 0)
            for (size_t i = 0; i < g64.gl_pathc; i++)
                printf("ENTRY glob64 %zu %s\n", i, g64.gl_pathv[i]);
        globfree64(&g64);
        return 0;
    }

    if (strcmp(mode, "mark") == 0) {
        rc = glob(pattern, GLOB_MARK, NULL, &g);
        dump("mark", rc, &g);
        globfree(&g);
        return 0;
    }

    fprintf(stderr, "unknown mode %s\n", mode);
    return 2;
}
