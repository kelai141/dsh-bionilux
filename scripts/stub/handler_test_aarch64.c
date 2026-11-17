/*
 * Offline unit test for the SIGSYS handler half of
 * scripts/stub/sigsys_stub_aarch64.S.
 *
 * This is not a signal test. It maps the assembled blob into RWX memory, calls
 * the handler as if it were an ordinary function with a hand-built siginfo_t
 * and a hand-built ucontext frame, and checks what the handler wrote back.
 * That isolates every decision the handler makes, leaving exactly one thing
 * untested offline: the kernel delivering a real SECCOMP_RET_TRAP signal to a
 * handler that lives in the interpreter's mapping. It also keeps the check
 * independent of qemu-user's known delivery defect (qemu 8.2 reports SIGILL for
 * a synchronous SIGSYS handler placed there), which is why the real-signal test
 * can only happen on a device.
 *
 * Build and run (aarch64, static so qemu-user needs no root filesystem):
 *   aarch64-linux-gnu-gcc -O1 -static -o /tmp/handler_test \
 *     scripts/stub/handler_test_aarch64.c
 *   qemu-aarch64-static /tmp/handler_test /tmp/sigsys_stub.bin 7c
 *
 * scripts/inject-sigsys-stub.test.mjs drives this when a cross toolchain and
 * qemu-aarch64-static are installed, and skips it otherwise.
 *
 * The case list follows _sigalts/COPY-SPEC.md section 8.5 (the eight cases that
 * spec calls for, plus the two adjacent-svc and tagged-filter variants). That
 * spec marks this "handler as a plain function" harness as the one new offline
 * technique this project adds, which is why it is not wired to real signals.
 * Design facts (offsets, the double pc probe, the success table) come from
 * cortex (Apache-2.0) via that spec; the code here is original.
 *
 * Frame offsets are the aarch64 ABI the stub documents, measured on the glibc
 * this project ships: ucontext.uc_mcontext at 176, regs[0] (x0) at 184,
 * regs[8] (x8) at 248, sp at 432, pc at 440, pstate at 448, __reserved at 452;
 * siginfo_t.si_signo/si_errno/si_code at 0/4/8.
 */
#define _GNU_SOURCE
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <stddef.h>
#include <ucontext.h>
#include <unistd.h>


#define UC_MCONTEXT 176
#define UC_REGS0 184
#define UC_REGS8 248
#define UC_SP 432
#define UC_PC 440
#define UC_PSTATE 448
#define UC_RESERVED 452
#define SYS_SECCOMP_CODE 1
#define SVC0 0xd4000001u /* "svc #0" */

/* The handler is assembly, so these offsets are hard numbers there. Assert them
 * against the headers this harness compiles with: a wrong offset would quietly
 * write into pstate (kernel "bad frame" -> SIGSEGV) instead of failing to build. */
_Static_assert(offsetof(ucontext_t, uc_mcontext) == UC_MCONTEXT, "uc_mcontext moved");
_Static_assert(offsetof(ucontext_t, uc_mcontext) + offsetof(mcontext_t, regs) == UC_REGS0,
               "regs[0] moved");
_Static_assert(offsetof(ucontext_t, uc_mcontext) + offsetof(mcontext_t, regs) + 8 * 8 == UC_REGS8,
               "regs[8] moved");
_Static_assert(offsetof(ucontext_t, uc_mcontext) + offsetof(mcontext_t, sp) == UC_SP, "sp moved");
_Static_assert(offsetof(ucontext_t, uc_mcontext) + offsetof(mcontext_t, pc) == UC_PC, "pc moved");
_Static_assert(offsetof(ucontext_t, uc_mcontext) + offsetof(mcontext_t, pstate) == UC_PSTATE,
               "pstate moved");
_Static_assert(offsetof(siginfo_t, si_errno) == 4, "si_errno moved");
_Static_assert(offsetof(siginfo_t, si_code) == 8, "si_code moved");

typedef void (*handler_fn)(int, void *, void *);

static int failures;

static void check(int condition, const char *what) {
    printf("%s %s\n", condition ? "ok" : "FAIL", what);
    if (!condition) {
        failures += 1;
    }
}

static uint64_t load32(const unsigned char *frame, size_t offset) {
    uint32_t value;
    memcpy(&value, frame + offset, sizeof value);
    return value;
}

/* Byte address of a fixture word, so pointer arithmetic stays explicit. */
static uint64_t address_of(const void *pointer, size_t bytes) {
    return (uint64_t)(const unsigned char *)pointer + bytes;
}

static uint64_t load64(const unsigned char *frame, size_t offset) {
    uint64_t value;
    memcpy(&value, frame + offset, sizeof value);
    return value;
}

static void store32(unsigned char *frame, size_t offset, uint32_t value) {
    memcpy(frame + offset, &value, sizeof value);
}

static void store64(unsigned char *frame, size_t offset, uint64_t value) {
    memcpy(frame + offset, &value, sizeof value);
}

/* The handler uses at most 64 bytes of the stack it is entered on, so the
 * ucontext is kept away from the edges of the mapped fixture. */
struct fixture {
    unsigned char below[2048];
    ucontext_t uc;
    unsigned char above[2048];
};

static struct fixture fixture;
/* Readable stand-in for the loader's text: 1 = svc #0, 0 = anything else. */
static uint32_t code_area[8];
static siginfo_t info;

static unsigned char *frame(void) { return (unsigned char *)&fixture.uc; }

static void reset_frame(uint64_t syscall_nr, uint64_t pc, uint64_t return_value) {
    memset(&fixture, 0, sizeof fixture);
    store64(frame(), UC_REGS0, return_value);
    store64(frame(), UC_REGS8, syscall_nr);
    store64(frame(), UC_PC, pc);
    store32(frame(), UC_PSTATE, 0x60000000u);
    store64(frame(), UC_RESERVED, 0xa5a5a5a5a5a5a5a5ull);
}

static void reset_info(int code, int errno_tag) {
    memset(&info, 0, sizeof info);
    info.si_signo = SIGSYS;
    info.si_code = code;
    info.si_errno = errno_tag;
}

static void dummy_handler(int sig, siginfo_t *si, void *uc) {
    (void)sig;
    (void)si;
    (void)uc;
}

static void install_dummy(void) {
    struct sigaction action;
    memset(&action, 0, sizeof action);
    action.sa_sigaction = dummy_handler;
    action.sa_flags = SA_SIGINFO;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGSYS, &action, NULL) != 0) {
        perror("sigaction dummy");
        exit(2);
    }
}

static int disposition_is_default(void) {
    struct sigaction action;
    if (sigaction(SIGSYS, NULL, &action) != 0) {
        perror("sigaction query");
        exit(2);
    }
    return action.sa_handler == SIG_DFL;
}

static int sigsys_pending(void) {
    sigset_t pending;
    if (sigpending(&pending) != 0) {
        perror("sigpending");
        exit(2);
    }
    return sigismember(&pending, SIGSYS) == 1;
}

int main(int argc, char **argv) {
    if (argc != 3) {
        fprintf(stderr, "usage: %s <stub.bin> <handler-offset-hex>\n", argv[0]);
        return 2;
    }
    unsigned long handler_offset = strtoul(argv[2], NULL, 16);
    int fd = open(argv[1], O_RDONLY);
    if (fd < 0) {
        perror("open stub");
        return 2;
    }
    static unsigned char stub[4096];
    ssize_t size = read(fd, stub, sizeof stub);
    close(fd);
    if (size <= 0 || (unsigned long)size <= handler_offset ||
        handler_offset + 4 > (unsigned long)size) {
        fprintf(stderr, "stub is too small for handler offset 0x%lx\n", handler_offset);
        return 2;
    }
    unsigned char *blob = mmap(NULL, 4096, PROT_READ | PROT_WRITE | PROT_EXEC,
                               MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (blob == MAP_FAILED) {
        perror("mmap");
        return 2;
    }
    memcpy(blob, stub, (size_t)size);
    handler_fn handler = (handler_fn)(void *)(blob + handler_offset);

    /* Keep SIGSYS blocked: the pass-through path re-delivers the signal, and
     * with the default action it would kill this harness before it reports. */
    sigset_t blocked;
    sigemptyset(&blocked);
    sigaddset(&blocked, SIGSYS);
    if (sigprocmask(SIG_BLOCK, &blocked, NULL) != 0) {
        perror("sigprocmask");
        return 2;
    }

    /* --- the measured normal case: kernel advanced pc past the svc --- */
    code_area[0] = SVC0;
    code_area[1] = 0xd503201fu; /* nop, where pc points after the advance */
    reset_frame(293 /* rseq, not in the success table */, (uint64_t)&code_area[1], 0x1234);
    reset_info(SYS_SECCOMP_CODE, 0);
    handler(31, &info, &fixture.uc);
    check(load64(frame(), UC_REGS0) == 0xffffffffffffffdaull,
          "trapped rseq returns -ENOSYS in regs[0]");
    check(load64(frame(), UC_PC) == address_of(&code_area[1], 0),
          "an advanced pc is left alone (not rewound, not stepped)");
    check(load32(frame(), UC_PSTATE) == 0x60000000u, "pstate is untouched");
    check(load64(frame(), UC_RESERVED) == 0xa5a5a5a5a5a5a5a5ull,
          "uc_mcontext.__reserved is untouched (kernel badframe check)");

    /* --- the success table, and a neighbour that must stay -ENOSYS --- */
    static const uint64_t zero_return[] = {
        146, /* setuid         */
        144, /* setgid         */
        145, /* setreuid       */
        143, /* setregid       */
        147, /* setresuid      */
        149, /* setresgid      */
        151, /* setfsuid       */
        152, /* setfsgid       */
        159, /* setgroups      */
        99,  /* set_robust_list */
    };
    static const char *const zero_return_names[] = {
        "setuid", "setgid", "setreuid", "setregid", "setresuid",
        "setresgid", "setfsuid", "setfsgid", "setgroups", "set_robust_list",
    };
    for (size_t i = 0; i < sizeof zero_return / sizeof zero_return[0]; i += 1) {
        reset_frame(zero_return[i], (uint64_t)&code_area[1], 0x1234);
        reset_info(SYS_SECCOMP_CODE, 0);
        handler(31, &info, &fixture.uc);
        char label[96];
        snprintf(label, sizeof label, "synthesised success for %s (%llu)",
                 zero_return_names[i], (unsigned long long)zero_return[i]);
        check(load64(frame(), UC_REGS0) == 0, label);
    }
    static const uint64_t enosys_calls[][2] = {
        {435, 0}, /* clone3: glibc falls back to clone() on ENOSYS */
        {97, 0},  /* unshare  */
        {293, 0}, /* rseq     */
        {165, 0}, /* mount    */
        {424, 0}, /* start of the 424..511 range */
        {511, 0}, /* end of that range */
    };
    static const char *const enosys_names[] = {
        "clone3", "unshare", "rseq", "mount", "number 424", "number 511",
    };
    for (size_t i = 0; i < sizeof enosys_calls / sizeof enosys_calls[0]; i += 1) {
        char label[96];
        reset_frame(enosys_calls[i][0], (uint64_t)&code_area[1], 0x1234);
        reset_info(SYS_SECCOMP_CODE, 0);
        handler(31, &info, &fixture.uc);
        snprintf(label, sizeof label, "trapped %s (%llu) answers -ENOSYS", enosys_names[i],
                 (unsigned long long)enosys_calls[i][0]);
        check(load64(frame(), UC_REGS0) == 0xffffffffffffffdaull, label);
    }
    reset_frame(240 /* rt_tgsigqueueinfo */, (uint64_t)&code_area[1], 0x1234);
    reset_info(SYS_SECCOMP_CODE, 0);
    handler(31, &info, &fixture.uc);
    check(load64(frame(), UC_REGS0) == 0xffffffffffffffdaull,
          "get_robust_list family stays -ENOSYS (out-parameter, never a fake 0)");

    /* --- pc repair only when the frame proves the kernel did not advance --- */
    code_area[3] = 0xd503201fu; /* nop */
    code_area[4] = SVC0;
    reset_frame(293, (uint64_t)&code_area[4], 0x1234);
    reset_info(SYS_SECCOMP_CODE, 0);
    handler(31, &info, &fixture.uc);
    check(load64(frame(), UC_PC) == address_of(&code_area[4], 4),
          "an unadvanced pc is stepped over the svc after checking pc - 4");

    code_area[6] = SVC0;
    code_area[7] = SVC0;
    reset_frame(293, (uint64_t)&code_area[7], 0x1234);
    reset_info(SYS_SECCOMP_CODE, 0);
    handler(31, &info, &fixture.uc);
    check(load64(frame(), UC_PC) == address_of(&code_area[7], 0),
          "two adjacent svcs are not mistaken for an unadvanced pc");

    /* --- signals that are not ours are re-delivered, not swallowed --- */
    install_dummy();
    reset_frame(293, (uint64_t)&code_area[1], 0x1234);
    reset_info(0 /* SI_USER, not SYS_SECCOMP */, 0);
    handler(31, &info, &fixture.uc);
    check(load64(frame(), UC_REGS0) == 0x1234, "a non-SYS_SECCOMP signal is not taken over");
    check(disposition_is_default(), "a non-SYS_SECCOMP signal drops our handler to SIG_DFL");
    check(sigsys_pending(), "a non-SYS_SECCOMP signal is re-queued, not swallowed");

    install_dummy();
    reset_frame(293, (uint64_t)&code_area[1], 0x1234);
    reset_info(SYS_SECCOMP_CODE, 7 /* SECCOMP_RET_DATA tag: a guest filter */);
    handler(31, &info, &fixture.uc);
    check(load64(frame(), UC_REGS0) == 0x1234, "a tagged SYS_SECCOMP signal is not taken over");
    check(disposition_is_default(), "a tagged SYS_SECCOMP signal drops our handler to SIG_DFL");
    check(sigsys_pending(), "a tagged SYS_SECCOMP signal is re-queued, not swallowed");

    printf("%s %d check(s) failed\n", failures == 0 ? "PASS" : "FAIL", failures);
    return failures == 0 ? 0 : 1;
}