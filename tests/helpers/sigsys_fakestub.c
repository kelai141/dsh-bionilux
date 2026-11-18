// Simulated loader entry stub for the SIGSYS guard tests.
//
// The real stub is injected at the loader's entry point, so its SIGSYS handler
// is installed before any LD_PRELOAD constructor runs. On the host this test
// library reproduces that ordering by being listed after the preload library
// on LD_PRELOAD: glibc initializes preload objects in reverse order, so this
// constructor runs first. The handler fills in -ENOSYS the way the stub's
// assembly handler does, and it publishes its own address in
// BIONILUX_SIGSYS_STUB, the marker the preload guard compares with the
// installed disposition.
#define _GNU_SOURCE
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ucontext.h>
#include <unistd.h>

static void stub_handler(int sig, siginfo_t *si, void *uc) {
    if (!si || si->si_code != 1 || si->si_errno != 0) {
        // Same fallback as the real stub: anything that did not come from the
        // runtime's own seccomp interaction goes back to the default action.
        struct sigaction dfl;
        memset(&dfl, 0, sizeof dfl);
        dfl.sa_handler = SIG_DFL;
        sigaction(SIGSYS, &dfl, NULL);
        raise(sig);
        return;
    }
#if defined(__x86_64__)
    ((ucontext_t *)uc)->uc_mcontext.gregs[REG_RAX] = -38;
#elif defined(__aarch64__)
    ((ucontext_t *)uc)->uc_mcontext.regs[0] = (unsigned long)-38;
#else
#error "unsupported architecture"
#endif
}

__attribute__((constructor)) static void stub_init(void) {
    struct sigaction act;
    memset(&act, 0, sizeof act);
    act.sa_sigaction = stub_handler;
    act.sa_flags = SA_SIGINFO;
    sigemptyset(&act.sa_mask);
    if (sigaction(SIGSYS, &act, NULL) != 0) {
        perror("fakestub: sigaction(SIGSYS)");
        _exit(70);
    }
    // BN_FAKESTUB_NO_MARKER=1 leaves whatever the harness put in
    // BIONILUX_SIGSYS_STUB untouched, which is how a marker mismatch and the
    // "no marker" fallback are exercised.
    if (!getenv("BN_FAKESTUB_NO_MARKER")) {
        char address[32];
        snprintf(address, sizeof address, "%lx", (unsigned long)(void *)stub_handler);
        if (setenv("BIONILUX_SIGSYS_STUB", address, 1) != 0) {
            perror("fakestub: setenv");
            _exit(70);
        }
    }
}
