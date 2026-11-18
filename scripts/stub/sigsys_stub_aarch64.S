/*
 * SIGSYS entry stub for an AArch64 dynamic loader (Debian ld.so).
 *
 * Why this exists
 * ---------------
 * An Android app process (targetSdk >= 29) inherits untrusted_app's seccomp
 * allowlist with SECCOMP_RET_TRAP as the default action. A denied syscall is
 * not answered with an error: the kernel raises SIGSYS synchronously, so the
 * thread dies with "Bad system call" unless a handler is already installed.
 * bionic never issues set_robust_list(99) or rseq(293), but glibc does from its
 * own startup path (init_tls, __tls_init_tp, start_thread). The build also
 * rewrites those two instruction sites to -ENOSYS (scripts/patch-android-glibc.mjs),
 * which covers only those two calls. Every other denied call - unshare, mount,
 * keyctl, io_uring_setup, bpf, SysV IPC - would still kill the process on the
 * spot, with no chance to degrade.
 *
 * The loader's original e_entry is retained because glibc compares AT_ENTRY
 * with _start to recognize direct invocation. The injector keeps the BTI pad
 * at _start and replaces the following frame-pointer reset with a branch to
 * this stub. The stub replays the reset, installs a SIGSYS handler, then unblocks
 * SIGSYS and branches to the rest of the loader's entry path. Any trapped
 * call returns an error the guest can handle instead of killing the thread.
 *
 * Blob layout (one contiguous .text blob; the injector copies it into the
 * loader's executable code cave and branches to it from _start + 4):
 *
 *   0x000  entry        bti c + mov x29, #0               <- 8-byte magic
 *   0x008  save x0..x9 on the stack
 *   0x020  rt_sigaction(SIGSYS, {handler, SA_SIGINFO, 0, 0})
 *   0x048  rt_sigprocmask(SIG_UNBLOCK, {SIGSYS})     <- handler already in place
 *   0x060  restore x0..x9, drop the frame
 *   0x078  b <original e_entry + 8>                       <- injector rewrites
 *   0x07c  handler                                        <- STUB_HANDLER_OFFSET
 *   0x168  ten synthetic-success syscall numbers (80 bytes)
 *   0x1b8  the SIGSYS sigset handed to rt_sigprocmask
 *   0x1c0  end of blob (448 bytes)
 *
 * Offsets are stated so the injector and the handler unit test can address the
 * branch and the handler without disassembly; the unit test asserts the words
 * at 0x000, 0x078 and 0x07c, so a source edit that moves them fails the build
 * instead of producing a stub with a stale entry point.
 *
 * The 8-byte magic is bti c (0xd503245f) then mov x29, #0 (0xd280001d),
 * so the little-endian bytes are 5f 24 03 d5 1d 00 80 d2. The
 * injector uses it to recognise an already-injected loader, and it is real code
 * on a BTI-aware kernel (a HINT NOP everywhere else). The loader this targets
 * carries GNU_PROPERTY AArch64 feature: BTI, PAC, so the stub starts with
 * bti c, and it returns to rtld with a direct branch, which BTI does not gate.
 *
 * The one instruction the injector rewrites is the placeholder "b ." at
 * STUB_BRANCH_OFFSET (0x78). It must stay "b ." (0x14000000) in this source;
 * the injector asserts that word and replaces it with the PC-relative branch to
 * the first undisplaced instruction of the original entry path.
 *
 * Registers, stack and signal frame contracts (measured on aarch64 glibc 2.41
 * and the trixie loader; the kernel's rt_sigframe and glibc ucontext_t share a
 * layout):
 *   ucontext_t.uc_mcontext             @ 176 from the ucontext pointer  (x2)
 *   uc_mcontext.regs[0] (x0)           @ 184  -> syscall return value
 *   uc_mcontext.regs[8] (x8)           @ 248  -> syscall number
 *   uc_mcontext.sp / pc / pstate       @ 432 / 440 / 448
 *   siginfo_t.si_signo/si_errno/si_code @ 0 / 4 / 8
 *
 * Handler rules that are not negotiable:
 *   - SECCOMP_RET_TRAP delivery has already advanced pc past the svc, so the
 *     normal path does not touch pc and never rewrites pstate or __reserved
 *     (the kernel's badframe check would turn that into SIGSEGV). The pc repair
 *     below only fires when pc still points at the svc itself, i.e. when the
 *     kernel did not advance, and it demands evidence before doing so.
 *   - Take over only si_code == SYS_SECCOMP(1) with si_errno == 0. si_errno
 *     carries SECCOMP_RET_DATA, so a non-zero tag means the guest installed its
 *     own filter; that SIGSYS is re-delivered with the default action instead
 *     of being swallowed.
 *   - Both stacks are small on purpose: the entry path uses 112 bytes and the
 *     handler 64 bytes of the stack it is entered on (the signal frame sits
 *     above it), well under the 128-byte assumption the runner makes.
 *
 * Provenance and licensing: the facts this file is built from (ucontext/offset
 * values, the svc #imm16 mask, the set*id syscall numbers, the "two-way pc
 * probe" order and the seven-step handler order) were read out of cortex
 * (https://github.com/ssfuisu/cortex, Apache-2.0) and are recorded in
 * _sigalts/COPY-SPEC.md sections 3 and 4. Facts, constants and algorithms are
 * not copyrightable, so no cortex source is copied here: every instruction
 * below was written for this project and only the numbers come from there. If
 * anyone later pastes a cortex snippet into this file, it must carry the
 * Apache-2.0 notice (source path, commit, "modified") plus a
 * THIRD_PARTY_NOTICES.md line, per that repo's policy.
 *
 * Rebuild (binutils 2.42 or newer; the blob is architecture-only, no relocations,
 * so the labels stay file-local and no linker step is needed):
 *   aarch64-linux-gnu-as -o /tmp/sigsys_stub.o scripts/stub/sigsys_stub_aarch64.S
 *   aarch64-linux-gnu-objcopy -O binary --only-section=.text \
 *     /tmp/sigsys_stub.o /tmp/sigsys_stub.bin
 *   xxd -p /tmp/sigsys_stub.bin | tr -d '\n'   # pasted as STUB_HEX below
 *
 * scripts/inject-sigsys-stub.mjs carries the assembled bytes as STUB_HEX and
 * scripts/inject-sigsys-stub.test.mjs rebuilds this file when a cross assembler
 * is installed and fails on any difference, so the two cannot drift.
 */

    .text

/* ------------------------------------------------------------------------ */
/* Entry path. The branch after the loader's BTI pad points here.            */
/* ------------------------------------------------------------------------ */
bionilux_sigsys_stub:
    bti     c                       /* 0xd503245f: BTI landing pad; NOP pre-8.5  */
    mov     x29, #0                 /* Replay the displaced loader instruction. */
    sub     sp, sp, #112            /* 80 bytes of registers + 32 for ksa */
    stp     x0, x1, [sp, #0]
    stp     x2, x3, [sp, #16]
    stp     x4, x5, [sp, #32]
    stp     x6, x7, [sp, #48]
    stp     x8, x9, [sp, #64]

    /* (1) Install the handler first: rt_sigaction(SIGSYS, ksa) with
     *   ksa = {handler, SA_SIGINFO, 0, 0} written as 32 bytes on the stack.
     * The kernel's struct sigaction is {handler, flags, restorer, mask} (32
     * bytes) while the 24-byte ABI in the old headers is {handler, flags, mask};
     * filling all 32 bytes with those values is correct under either reading and
     * a zero mask is what both want. SA_RESTORER does not exist on arm64, the
     * kernel supplies the sigreturn trampoline. */
    adr     x4, bionilux_sigsys_handler
    mov     x5, #4                  /* SA_SIGINFO, no other flag */
    stp     x4, x5, [sp, #80]       /* ksa.handler, ksa.flags  */
    stp     xzr, xzr, [sp, #96]     /* ksa.restorer = 0, ksa.mask = 0 */
    add     x1, sp, #80
    mov     x0, #31                 /* SIGSYS */
    mov     x2, #0                  /* old action: not needed */
    mov     x3, #8                  /* sigsetsize: 64-bit sigset */
    mov     x8, #134                /* rt_sigaction */
    svc     #0

    /* (2) Now unblock SIGSYS. exec keeps the caller's signal mask and a TRAPped
     * call while SIGSYS is blocked kills the thread outright, so the mask has to
     * be cleared before the first rtld instruction - and only after the handler
     * is in place, so there is no window where the signal can arrive unhandled.
     * The kernel's how argument is asm-generic: SIG_BLOCK 0, SIG_UNBLOCK 1,
     * SIG_SETMASK 2. SIG_SETMASK would install a mask of exactly {SIGSYS}, i.e.
     * block the very signal this stub exists to receive. */
    adr     x1, sigsys_only_set
    mov     x0, #1                  /* SIG_UNBLOCK */
    mov     x2, #0                  /* old set: we do not need it */
    mov     x3, #8                  /* sigsetsize: 64-bit sigset */
    mov     x8, #135                /* rt_sigprocmask */
    svc     #0

    /* (3) Restore the entry registers and resume at _start + 8. The landing
     * pad and frame-pointer reset have already run. */
    ldp     x0, x1, [sp, #0]
    ldp     x2, x3, [sp, #16]
    ldp     x4, x5, [sp, #32]
    ldp     x6, x7, [sp, #48]
    ldp     x8, x9, [sp, #64]
    add     sp, sp, #112
bionilux_stub_branch:
    b       .                       /* placeholder 0x14000000; injector rewrites */

/* ------------------------------------------------------------------------ */
/* SIGSYS handler: x0 = signo, x1 = siginfo_t *, x2 = ucontext_t *.          */
/* The synthetic return value goes into uc_mcontext.regs[0]; pc is repaired  */
/* only when the frame proves the kernel did not advance it.                 */
/* ------------------------------------------------------------------------ */
bionilux_sigsys_handler:
    bti     c                       /* handler may be entered with BTYPE=call  */
    /* Step 1: nothing to read. The kernel always supplies both pointers for an
     * SA_SIGINFO delivery; this only keeps a corrupted frame from faulting
     * inside the handler, which would be fatal. */
    cbz     x1, .Lhandler_ret
    cbz     x2, .Lhandler_ret
    /* Step 2: only seccomp traps. Anything else is somebody else's SIGSYS. */
    ldr     w3, [x1, #8]            /* siginfo.si_code */
    cmp     w3, #1                  /* SYS_SECCOMP */
    b.ne    .Lpass_through
    /* Step 3: si_errno carries SECCOMP_RET_DATA; a tag means a guest filter. */
    ldr     w3, [x1, #4]
    cbnz    w3, .Lpass_through

    /* Steps 4 and 5: decide the synthetic return value and write it to
     * uc_mcontext.regs[0]. Everything not listed in the success table answers
     * -ENOSYS, which is the only answer that cannot be mistaken for success. */
    ldr     x3, [x2, #248]          /* uc_mcontext.regs[8] = syscall number */
    adr     x4, .Lzero_return_syscalls
    mov     x5, #10
.Lscan:
    ldr     x6, [x4], #8
    cmp     x6, x3
    b.eq    .Lreturn_zero
    subs    x5, x5, #1
    b.ne    .Lscan
    mov     x3, #-38                /* default: -ENOSYS */
    b       .Lstore
.Lreturn_zero:
    mov     x3, #0
.Lstore:
    str     x3, [x2, #184]          /* uc_mcontext.regs[0] */

    /* Step 6: two-way pc probe; the default is to leave pc exactly as the
     * kernel left it. Linux advances pc past the trapped svc, so a normal frame
     * has pc pointing at the next instruction and nothing to fix. If pc itself
     * holds an svc the kernel did not advance and the call would run twice, but
     * only when the preceding word is not also an svc (two adjacent svc
     * instructions would otherwise look like an unadvanced pc). Any svc #imm16
     * form counts, matching cortex's (insn & 0xffe0001f) == 0xd4000001. */
    ldr     x3, [x2, #440]          /* uc_mcontext.pc */
    ldr     w4, [x3]
    movz    w7, #0xd400, lsl #16    /* w7 = 0xd4000001 */
    movk    w7, #0x0001
    movz    w6, #0x001f             /* w6 = 0xffe0001f, ignoring imm16 */
    movk    w6, #0xffe0, lsl #16
    and     w5, w4, w6
    cmp     w5, w7
    b.ne    .Lhandler_ret           /* pc does not hold an svc */
    ldr     w5, [x3, #-4]
    and     w5, w5, w6
    cmp     w5, w7
    b.eq    .Lhandler_ret           /* a svc preceded it: pc really was advanced */
    add     x3, x3, #4
    str     x3, [x2, #440]
.Lhandler_ret:
    ret                             /* step 7: pstate and __reserved untouched */

    /* Not ours: the signal came from a guest filter (SECCOMP_RET_DATA tag) or
     * from something outside seccomp. There is no raise() here, so the re-delivery
     * is three raw syscalls: drop our handler back to SIG_DFL, then tgkill this
     * thread with the same signal; the default action terminates the process, which
     * is exactly what would have happened without this stub. Syscall numbers used
     * (all of them in bionic's allowlist): rt_sigaction 134, gettid 178, getpid 172,
     * tgkill 131. If the requeue itself were trapped we would be back in this
     * handler with SIG_DFL installed, so the process still dies - no recursion. */
.Lpass_through:
    sub     sp, sp, #64
    stp     x0, x1, [sp, #0]        /* signo, siginfo */
    stp     x2, x3, [sp, #16]       /* ucontext */
    stp     xzr, xzr, [sp, #32]     /* kernel_sigaction {SIG_DFL, 0} */
    stp     xzr, xzr, [sp, #48]     /* restorer = 0, mask = 0 */
    mov     x0, #31
    add     x1, sp, #32
    mov     x2, #0
    mov     x3, #8
    mov     x8, #134                /* rt_sigaction(SIGSYS, SIG_DFL) */
    svc     #0
    mov     x8, #178                /* gettid -> x0 = tid */
    svc     #0
    mov     x1, x0                  /* tid */
    mov     x8, #172                /* getpid -> x0 = tgid */
    svc     #0
    mov     x2, #31                 /* SIGSYS */
    mov     x8, #131                /* tgkill(tgid, tid, SIGSYS) */
    svc     #0
    ldp     x0, x1, [sp, #0]
    ldp     x2, x3, [sp, #16]
    add     sp, sp, #64
    ret

/* ------------------------------------------------------------------------ */
/* Read-only tables.                                                         */
/*                                                                           */
/* Answer success only where a failure would be a lie about this process:     */
/* the whole guest runs as one Android uid, so dropping privileges to that    */
/* same uid cannot fail in any useful way, and glibc's nss/init paths treat a */
/* failure there as fatal. aarch64 syscall numbers (asm-generic).            */
/*                                                                           */
/* Provenance, so a later reader does not have to re-derive it:               */
/*   - the nine set*id rows are cortex's table A (hook/syscalls.c). Their     */
/*     guest is also a single-uid prefix, so the same compromise applies:     */
/*     getuid() keeps reporting the real Android uid while these calls       */
/*     report success.                                                       */
/*   - set_robust_list is this project's call: glibc defines                 */
/*     __ASSUME_SET_ROBUST_LIST and never looks at the return value, so 0 and */
/*     -ENOSYS behave identically here; cortex patches the instruction to a  */
/*     nop instead (leaving x0 as the caller's pointer, equally non-error).   */
/*     0 is chosen because this handler can only answer through regs[0].      */
/*   - get_robust_list stays on the -ENOSYS default, which is a deliberate    */
/*     departure from cortex (they synthesise 0 after zeroing the out        */
/*     parameters): its arguments are out-parameters, and a synthetic success */
/*     with an untouched out-parameter hands the caller an uninitialised      */
/*     pointer. Nothing in the guest relies on the success path.             */
/*   - unshare/add_key/request_key/keyctl/setns/seccomp/bpf/clone3 and the    */
/*     424..511 range already answer -ENOSYS through the default, which is    */
/*     what glibc's fallback paths (clone3 -> clone, rseq -> tunable) expect. */
/*     rseq must NOT report success: that would tell glibc the registration   */
/*     worked and it would then read memory that was never registered.        */
/* ------------------------------------------------------------------------ */
    .p2align 3
.Lzero_return_syscalls:
    .quad   146                     /* setuid         (cortex)  */
    .quad   144                     /* setgid         (cortex)  */
    .quad   145                     /* setreuid       (cortex)  */
    .quad   143                     /* setregid       (cortex)  */
    .quad   147                     /* setresuid      (cortex)  */
    .quad   149                     /* setresgid      (cortex)  */
    .quad   151                     /* setfsuid       (cortex)  */
    .quad   152                     /* setfsgid       (cortex)  */
    .quad   159                     /* setgroups      (cortex)  */
    .quad   99                      /* set_robust_list (ours)   */

    .p2align 3
sigsys_only_set:
    .quad   0x0000000040000000      /* 1 << (SIGSYS - 1), SIGSYS = 31 */

    .section .note.GNU-stack,"",%progbits
    .end
