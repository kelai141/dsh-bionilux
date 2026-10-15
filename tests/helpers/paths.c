// Probe program for the bionilux preload hooks.
//
// It calls ordinary libc entry points against guest-absolute paths and prints
// one `key=value` line per observation, so the shell runner can assert on the
// result. Building and running this under a real glibc is what makes the
// path-mapping claims in docs/ROOTFS.md verifiable.
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <unistd.h>

static void trim_newline(char *s) {
    size_t n = strlen(s);
    while (n && (s[n - 1] == '\n' || s[n - 1] == '\r')) s[--n] = '\0';
}

// Read a file's first line through fopen, or report the errno.
static void probe_fopen(const char *key, const char *path) {
    FILE *f = fopen(path, "r");
    if (!f) {
        printf("%s=errno:%d\n", key, errno);
        return;
    }
    char buf[256] = {0};
    if (!fgets(buf, sizeof buf, f)) {
        printf("%s=empty\n", key);
        fclose(f);
        return;
    }
    trim_newline(buf);
    printf("%s=%s\n", key, buf);
    fclose(f);
}

// Same through raw open(), which is what most programs use.
static void probe_open(const char *key, const char *path) {
    int fd = open(path, O_RDONLY);
    if (fd < 0) {
        printf("%s=errno:%d\n", key, errno);
        return;
    }
    char buf[256] = {0};
    ssize_t n = read(fd, buf, sizeof buf - 1);
    close(fd);
    if (n <= 0) {
        printf("%s=empty\n", key);
        return;
    }
    buf[n] = '\0';
    trim_newline(buf);
    printf("%s=%s\n", key, buf);
}

int main(void) {
    char cwd[PATH_MAX] = {0};

    // 1. Guest files, through the two entry points that matter most.
    probe_fopen("fopen_etc", "/etc/bn-marker");
    probe_open("open_usr_share", "/usr/share/bn-marker");

    // 2. A path the host has but the guest does not must fail, not fall back.
    probe_open("guest_only_fail", "/etc/os-release");

    // 3. Metadata calls.
    struct stat st;
    printf("stat_guest_file=%d\n", stat("/etc/bn-marker", &st) == 0);
    printf("lstat_guest_file=%d\n", lstat("/etc/bn-marker", &st) == 0);
    printf("stat_missing=%d\n", stat("/etc/definitely-absent", &st) == -1 && errno == ENOENT);
    printf("access_guest=%d\n", access("/etc/bn-marker", R_OK) == 0);
    printf("access_missing=%d\n", access("/var/definitely-absent", F_OK) == -1 && errno == ENOENT);

    struct statvfs vfs;
    printf("statvfs_root=%d\n", statvfs("/", &vfs) == 0);

    // 4. Directory listing, resolved through the rootfs.
    DIR *d = opendir("/usr/bin");
    printf("opendir_usr_bin=%d\n", d != NULL);
    if (d) {
        int found = 0;
        struct dirent *e;
        while ((e = readdir(d))) {
            if (strcmp(e->d_name, "bn-tool") == 0) found = 1;
        }
        closedir(d);
        printf("readdir_finds_bn_tool=%d\n", found);
    } else {
        printf("readdir_finds_bn_tool=0\n");
    }

    // 5. Host virtual file systems must stay with the host kernel.
    printf("dev_null_writable=%d\n", access("/dev/null", W_OK) == 0);
    printf("proc_self_exe=%d\n", access("/proc/self/exe", R_OK) == 0);
    printf("proc_self_status=%d\n", access("/proc/self/status", R_OK) == 0);

    // 6. The working directory is reported the way the guest named it.
    printf("getcwd_at_root=%s\n", getcwd(cwd, sizeof cwd) ? cwd : "ERR");
    if (chdir("/usr/share") == 0) {
        char sub[PATH_MAX] = {0};
        printf("getcwd_after_chdir=%s\n", getcwd(sub, sizeof sub) ? sub : "ERR");
        if (chdir("/") != 0) printf("getcwd_after_chdir=chdir-back-failed\n");
    } else {
        printf("getcwd_after_chdir=chdir-failed\n");
    }
    printf("getcwd_back_at_root=%s\n", getcwd(cwd, sizeof cwd) ? cwd : "ERR");

    // 7. Writing inside the guest lands inside the guest.
    int wfd = open("/tmp/bn-written", O_CREAT | O_WRONLY | O_TRUNC, 0644);
    if (wfd >= 0) {
        ssize_t n = write(wfd, "written\n", 8);
        close(wfd);
        printf("create_in_guest=%d\n", n == 8);
    } else {
        printf("create_in_guest=errno:%d\n", errno);
    }

    // 8. mkdir + readdir on the new directory.
    printf("mkdir_guest=%d\n", mkdir("/var/bn-newdir", 0755) == 0);
    printf("rmdir_guest=%d\n", rmdir("/var/bn-newdir") == 0);

    // 9. Symlink round trip. The link is created with a guest-absolute target,
    //    which must still resolve inside the guest and read back unchanged.
    unlink("/usr/share/bn-link");
    printf("symlink_create=%d\n", symlink("/etc/bn-marker", "/usr/share/bn-link") == 0);
    char link[PATH_MAX] = {0};
    ssize_t lr = readlink("/usr/share/bn-link", link, sizeof link - 1);
    if (lr > 0) {
        link[lr] = '\0';
        printf("readlink=%s\n", link);
    } else {
        printf("readlink=errno:%d\n", errno);
    }
    probe_open("open_through_link", "/usr/share/bn-link");

    // 10. realpath reports the guest's own view.
    char rp[PATH_MAX] = {0};
    printf("realpath=%s\n", realpath("/usr/share/bn-marker", rp) ? rp : "ERR");

    // 11. Identity. apt and dpkg need to see uid 0.
    printf("uid=%d\n", (int)getuid());
    printf("euid=%d\n", (int)geteuid());
    printf("gid=%d\n", (int)getgid());

    // 12. A relative path resolves against the guest working directory.
    printf("stat_relative=%d\n", stat("./etc/bn-marker", &st) == 0);

    // 13. ".." must not climb out of the guest. The runner creates
    //     ../escape-target as a sibling of the rootfs, so a leak shows up as
    //     a successful open rather than as a missing file.
    probe_open("escape_from_root", "../escape-target");
    probe_open("dotdot_stays_inside", "../etc/bn-marker");

    if (chdir("/usr") == 0) {
        probe_open("escape_from_usr", "../../escape-target");
        probe_open("dotdot_deep_inside", "../../etc/bn-marker");
        chdir("/");
    } else {
        printf("escape_from_usr=chdir-failed\n");
        printf("dotdot_deep_inside=chdir-failed\n");
    }

    // An absolute path with ".." is clamped at the guest root too.
    probe_open("escape_absolute", "/../../escape-target");

    return 0;
}
