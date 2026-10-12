// Exercises execle() with multiple args and a custom envp.
// Prints "hello" via /bin/sh reading $TESTVAR.
#include <unistd.h>
#include <stdio.h>

int main(void) {
    char *envp[] = { "TESTVAR=hello", "PATH=/data/data/com.termux/files/usr/glibc/bin:/data/data/com.termux/files/usr/bin", NULL };
    execle("/data/data/com.termux/files/usr/glibc/bin/sh",
           "sh", "-c", "echo $TESTVAR", NULL, envp);
    perror("execle");
    return 1;
}