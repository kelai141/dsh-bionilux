// Behavior probe for the SIGSYS guard in src/preload/hooks.c.
//
// The entry stub is simulated by sigsys_fakestub.c. This program only reports
// observable guest behavior -- blocked masks, oldact values, chained delivery
// and the result of a seccomp-trapped syscall -- as key=value lines that
// tests/sigsys_guard.sh asserts on. It installs its own seccomp filter with
// SECCOMP_RET_TRAP, which is the Android policy this guard exists for, so no
// device is required.
#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ucontext.h>
#include <unistd.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <linux/filter.h>
#include <linux/seccomp.h>

// The handlers below run from a signal context the compiler cannot see, so the
// counters they own must be volatile or an optimised build keeps the pre-signal
// value in a register across raise().
static volatile int guest_calls;
static volatile int guest_code = -999;
static volatile int guest_errno_seen = -999;
static volatile int simple_calls;

static void report(const char *key, long value) {
    printf("%s=%ld\n", key, value);
}

static void guest_handler(int sig, siginfo_t *si, void *uc) {
    (void)sig;
    guest_calls++;
    guest_code = si ? si->si_code : -1;
    guest_errno_seen = si ? si->si_errno : -1;
    // A handler for a trapped syscall owns the result; report -ENOSYS the same
    // way the runtime handler does so the chained and tagged runs are
    // indistinguishable from the caller's side except for the counters above.
    if (si && si->si_code == 1 && uc) {
#if defined(__x86_64__)
        ((ucontext_t *)uc)->uc_mcontext.gregs[REG_RAX] = -38;
#elif defined(__aarch64__)
        ((ucontext_t *)uc)->uc_mcontext.regs[0] = (unsigned long)-38;
#endif
    }
}

static void simple_handler(int sig) {
    (void)sig;
    simple_calls++;
}

static int is_blocked(int sig) {
    sigset_t current;
    if (sigprocmask(0, NULL, &current) != 0) return -1;
    return sigismember(&current, sig);
}

// Block SIGSYS behind the guard's back; used to prove SIG_UNBLOCK also strips
// the signal instead of trusting the caller to name it.
static long raw_block_sigsys(void) {
    sigset_t raw;
    sigemptyset(&raw);
    sigaddset(&raw, SIGSYS);
    return syscall(SYS_rt_sigprocmask, SIG_BLOCK, &raw, NULL, 8);
}

// Traps one unprivileged, side-effect-free syscall. `tag` becomes the
// SECCOMP_RET_DATA value, which the kernel reports in si_errno.
static void install_trap(unsigned int tag) {
    struct sock_filter code[] = {
        { .code = BPF_LD | BPF_W | BPF_ABS, .k = (unsigned int)offsetof(struct seccomp_data, nr) },
        { .code = BPF_JMP | BPF_JEQ | BPF_K, .jt = 0, .jf = 1, .k = (unsigned int)SYS_getppid },
        { .code = BPF_RET | BPF_K, .k = SECCOMP_RET_TRAP | tag },
        { .code = BPF_RET | BPF_K, .k = SECCOMP_RET_ALLOW },
    };
    struct sock_fprog program = {
        .len = (unsigned short)(sizeof code / sizeof code[0]),
        .filter = code,
    };
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
        perror("no_new_privs");
        _exit(2);
    }
    if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program, 0, 0) != 0) {
        perror("seccomp");
        _exit(2);
    }
}

static void trapped_call(void) {
    errno = 0;
    long rc = syscall(SYS_getppid);
    report("trap_rc", rc);
    report("trap_errno", errno);
}

static void install_guest(void) {
    struct sigaction act;
    memset(&act, 0, sizeof act);
    act.sa_sigaction = guest_handler;
    act.sa_flags = SA_SIGINFO;
    sigemptyset(&act.sa_mask);
    struct sigaction old;
    memset(&old, 0, sizeof old);
    report("install_rc", sigaction(SIGSYS, &act, &old));
    report("install_oldact_default", old.sa_handler == SIG_DFL);
}

// Guard armed: the guest sees its own SIGSYS semantics while the runtime keeps
// the handler.
static void run_guarded(void) {
    sigset_t set, old;
    sigemptyset(&set);
    sigaddset(&set, SIGSYS);
    sigaddset(&set, SIGUSR1);
    memset(&old, 0, sizeof old);
    report("block_rc", sigprocmask(SIG_BLOCK, &set, &old));
    report("blocked_sigsys", is_blocked(SIGSYS));
    report("blocked_sigusr1", is_blocked(SIGUSR1));
    report("oldset_sigsys", sigismember(&old, SIGSYS));
    report("oldset_sigusr1", sigismember(&old, SIGUSR1));

    report("raw_block_rc", raw_block_sigsys());
    report("blocked_after_raw", is_blocked(SIGSYS));
    sigset_t unblock;
    sigemptyset(&unblock);
    sigaddset(&unblock, SIGUSR2);
    report("unblock_rc", sigprocmask(SIG_UNBLOCK, &unblock, NULL));
    report("blocked_after_unblock", is_blocked(SIGSYS));

    install_guest();
    struct sigaction query;
    memset(&query, 0, sizeof query);
    report("query_rc", sigaction(SIGSYS, NULL, &query));
    report("query_same", query.sa_sigaction == guest_handler);

    struct sigaction second;
    memset(&second, 0, sizeof second);
    second.sa_sigaction = guest_handler;
    second.sa_flags = SA_SIGINFO;
    sigemptyset(&second.sa_mask);
    struct sigaction previous;
    memset(&previous, 0, sizeof previous);
    report("reinstall_rc", sigaction(SIGSYS, &second, &previous));
    report("reinstall_oldact_same", previous.sa_sigaction == guest_handler);

    struct sigaction refused = second;
    refused.sa_flags = SA_SIGINFO | SA_RESETHAND;
    errno = 0;
    report("reject_rc", sigaction(SIGSYS, &refused, NULL));
    report("reject_errno", errno);

    // A signal the runtime did not generate is chained to the guest handler.
    guest_calls = 0;
    raise(SIGSYS);
    report("chained_calls", guest_calls);
    report("chained_code", guest_code);

    install_trap(0);
    trapped_call();
}

// Guard armed, guest seccomp filter with a tag: the guard must not swallow it.
static void run_tagged(void) {
    install_guest();
    install_trap(0x1234);
    guest_calls = 0;
    trapped_call();
    report("tagged_calls", guest_calls);
    report("tagged_code", guest_code);
    report("tagged_errno", guest_errno_seen);
}

// Guard armed, signal(): the guest-visible handler is recorded and chained.
static void run_signal(void) {
    sighandler_t previous = signal(SIGSYS, simple_handler);
    report("signal_previous_default", previous == SIG_DFL);
    simple_calls = 0;
    raise(SIGSYS);
    report("signal_calls", simple_calls);
    report("signal_query_same", signal(SIGSYS, SIG_IGN) == simple_handler);
    raise(SIGSYS);
    report("signal_ignored", 1);
}

// Guard not armed: everything must look exactly like plain glibc.
static void run_plain(void) {
    sigset_t set;
    sigemptyset(&set);
    sigaddset(&set, SIGSYS);
    report("block_rc", sigprocmask(SIG_BLOCK, &set, NULL));
    report("blocked_sigsys", is_blocked(SIGSYS));
    install_guest();
    struct sigaction query;
    memset(&query, 0, sizeof query);
    report("query_rc", sigaction(SIGSYS, NULL, &query));
    report("query_same", query.sa_sigaction == guest_handler);
}

// Blocks SIGSYS and then makes a trapped call; with a working guard this
// returns, otherwise the kernel kills the thread.
static void run_die(void) {
    sigset_t set;
    sigemptyset(&set);
    sigaddset(&set, SIGSYS);
    report("block_rc", sigprocmask(SIG_BLOCK, &set, NULL));
    report("blocked_sigsys", is_blocked(SIGSYS));
    install_trap(0);
    trapped_call();
    report("survived", 1);
}

// Same, but the guest also replaces the disposition with the default action.
static void run_die_replace(void) {
    struct sigaction dfl;
    memset(&dfl, 0, sizeof dfl);
    dfl.sa_handler = SIG_DFL;
    report("replace_rc", sigaction(SIGSYS, &dfl, NULL));
    install_trap(0);
    trapped_call();
    report("survived", 1);
}

int main(int argc, char **argv) {
    const char *mode = argc > 1 ? argv[1] : "plain";
    if (!strcmp(mode, "guard")) run_guarded();
    else if (!strcmp(mode, "tagged")) run_tagged();
    else if (!strcmp(mode, "signal")) run_signal();
    else if (!strcmp(mode, "plain")) run_plain();
    else if (!strcmp(mode, "die")) run_die();
    else if (!strcmp(mode, "die-replace")) run_die_replace();
    else {
        fprintf(stderr, "unknown mode: %s\n", mode);
        return 2;
    }
    return 0;
}
