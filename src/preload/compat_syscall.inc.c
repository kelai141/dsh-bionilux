// libc syscall() compatibility for code that bypasses the named wrappers.
//
// libuv's stat path calls syscall(SYS_statx, ...) directly, so the statx()
// interposer in hooks.c never sees it. Managed runtimes also reach the *at
// entry points this way. This file interposes the public glibc syscall()
// symbol only for the path operations hooks.c already maps.
//
// Every other syscall number is forwarded in assembly, before any C frame is
// created. That keeps clone/vfork/stack-switching calls on the same register
// path as glibc's own syscall stub. A cached RTLD_NEXT pointer is used when the
// constructor has run; the naked fallback implements the same ABI shuffle,
// syscall instruction, -errno check and errno store for the first call.
//
// This covers calls through libc's syscall symbol. A raw `syscall` instruction
// in the application, or a statically linked Go runtime using its own assembly
// stubs, never enters the dynamic linker and cannot be intercepted here.

#include <sys/syscall.h>

#if !defined(__x86_64__) && !defined(__aarch64__)
#error "compat_syscall.inc.c supports only x86_64 and aarch64"
#endif

#if defined(SYS_newfstatat)
#define BN_COMPAT_NEWFSTATAT SYS_newfstatat
#elif defined(SYS_fstatat)
#define BN_COMPAT_NEWFSTATAT SYS_fstatat
#endif

static long bn_compat_syscall_result(long ret) {
    if (ret < 0 && ret >= -4095) {
        errno = (int)-ret;
        return -1;
    }
    return ret;
}

// Used by the four path helpers below. The assembly entry point does not call
// this for unknown numbers.
static long bn_compat_raw_syscall(long nr, long a1, long a2, long a3,
                                  long a4, long a5, long a6) {
#if defined(__x86_64__)
    long ret;
    register long r10 __asm__("r10") = a4;
    register long r8 __asm__("r8") = a5;
    register long r9 __asm__("r9") = a6;
    __asm__ volatile("syscall"
                     : "=a"(ret)
                     : "a"(nr), "D"(a1), "S"(a2), "d"(a3),
                       "r"(r10), "r"(r8), "r"(r9)
                     : "rcx", "r11", "memory");
    return ret;
#else
    register long x8 __asm__("x8") = nr;
    register long x0 __asm__("x0") = a1;
    register long x1 __asm__("x1") = a2;
    register long x2 __asm__("x2") = a3;
    register long x3 __asm__("x3") = a4;
    register long x4 __asm__("x4") = a5;
    register long x5 __asm__("x5") = a6;
    __asm__ volatile("svc 0"
                     : "+r"(x0)
                     : "r"(x1), "r"(x2), "r"(x3), "r"(x4), "r"(x5),
                       "r"(x8)
                     : "memory");
    return x0;
#endif
}

static long bn_compat_call(long nr, long a1, long a2, long a3,
                           long a4, long a5, long a6) {
    return bn_compat_syscall_result(
        bn_compat_raw_syscall(nr, a1, a2, a3, a4, a5, a6));
}

#ifdef SYS_statx
static long bn_compat_statx_call(long dirfd, long path, long flags, long mask,
                                 long st) {
    char buf[PATH_MAX];
    int saved = errno;
    const char *p = bn_resolve((int)dirfd, (const char *)(uintptr_t)path,
                               buf, sizeof buf);
    long rc = bn_compat_call(SYS_statx, dirfd, (long)(uintptr_t)p, flags, mask,
                             st, 0);
    if (rc == 0) {
        if (bn_fake_root() && st) {
            struct statx *sx = (struct statx *)(uintptr_t)st;
            sx->stx_uid = bn_vruid;
            sx->stx_gid = bn_vrgid;
        }
        errno = saved;
    }
    return rc;
}
#endif

#ifdef BN_COMPAT_NEWFSTATAT
static long bn_compat_newfstatat_call(long dirfd, long path, long st,
                                      long flags) {
    char buf[PATH_MAX];
    int saved = errno;
    const char *p = bn_resolve((int)dirfd, (const char *)(uintptr_t)path,
                               buf, sizeof buf);
    long rc = bn_compat_call(BN_COMPAT_NEWFSTATAT, dirfd, (long)(uintptr_t)p,
                             st, flags, 0, 0);
    if (rc == 0) {
        if (bn_fake_root() && st) BN_VIRT_STAT(*(struct stat *)(uintptr_t)st);
        errno = saved;
    }
    return rc;
}
#endif

#ifdef SYS_openat
static long bn_compat_openat_call(long dirfd, long path, long flags, long mode) {
    char buf[PATH_MAX];
    const char *p = bn_resolve((int)dirfd, (const char *)(uintptr_t)path,
                               buf, sizeof buf);
    if (!open_uses_mode((int)flags)) mode = 0;
    return bn_compat_call(SYS_openat, dirfd, (long)(uintptr_t)p, flags, mode, 0, 0);
}
#endif

#ifdef SYS_readlinkat
static long bn_compat_readlinkat_call(long dirfd, long path, long buf, long size) {
    char *out = (char *)(uintptr_t)buf;
    const char *name = (const char *)(uintptr_t)path;
    if (bn_self_exe(name)) {
        ssize_t r = fake_exe(out, (size_t)size);
        if (r >= 0) return (long)r;
    }
    if (!size) { errno = EINVAL; return -1; }

    char mapped[PATH_MAX], raw[PATH_MAX + 1];
    int saved = errno;
    const char *p = bn_resolve((int)dirfd, name, mapped, sizeof mapped);
    long rc = bn_compat_call(SYS_readlinkat, dirfd, (long)(uintptr_t)p,
                             (long)(uintptr_t)raw, PATH_MAX, 0, 0);
    if (rc <= 0) return rc;
    raw[rc] = '\0';
    char logical[PATH_MAX];
    const char *u = bn_unmap(raw, logical, sizeof logical);
    size_t len = strlen(u);
    size_t copy = len < (size_t)size ? len : (size_t)size;
    memcpy(out, u, copy);
    errno = saved;
    return (long)copy;
}
#endif

static long bn_compat_dispatch_locked(long nr, long a1, long a2, long a3,
                                      long a4, long a5, long a6) {
    switch (nr) {
#ifdef SYS_statx
    case SYS_statx: return bn_compat_statx_call(a1, a2, a3, a4, a5);
#endif
#ifdef BN_COMPAT_NEWFSTATAT
    case BN_COMPAT_NEWFSTATAT: return bn_compat_newfstatat_call(a1, a2, a3, a4);
#endif
#ifdef SYS_openat
    case SYS_openat: return bn_compat_openat_call(a1, a2, a3, a4);
#endif
#ifdef SYS_readlinkat
    case SYS_readlinkat: return bn_compat_readlinkat_call(a1, a2, a3, a4);
#endif
#ifdef SYS_readlink
    case SYS_readlink: return bn_compat_readlinkat_call(AT_FDCWD, a1, a2, a3);
#endif
    default:
        return bn_compat_call(nr, a1, a2, a3, a4, a5, a6);
    }
}

__attribute__((used, noinline, visibility("hidden")))
long bn_compat_syscall_dispatch(long nr, long a1, long a2, long a3,
                                long a4, long a5, long a6) {
    static _Thread_local int active;
    if (active) return bn_compat_call(nr, a1, a2, a3, a4, a5, a6);
    active = 1;
    long rc = bn_compat_dispatch_locked(nr, a1, a2, a3, a4, a5, a6);
    active = 0;
    return rc;
}

typedef long (*bn_compat_syscall_fn)(long, ...);

__attribute__((visibility("hidden")))
bn_compat_syscall_fn bn_compat_real_syscall;

__attribute__((constructor)) static void bn_compat_syscall_init(void) {
    bn_compat_real_syscall = (bn_compat_syscall_fn)dlsym(RTLD_NEXT, "syscall");
}

#define BN_ASM_STR_(x) #x
#define BN_ASM_STR(x) BN_ASM_STR_(x)

#if defined(__x86_64__)
__asm__(
    ".text\n"
    ".p2align 4\n"
    ".globl syscall\n"
    ".type syscall,@function\n"
    "syscall:\n"
#ifdef SYS_statx
    "    cmpl $" BN_ASM_STR(SYS_statx) ", %edi\n"
    "    je 1f\n"
#endif
#ifdef BN_COMPAT_NEWFSTATAT
    "    cmpl $" BN_ASM_STR(BN_COMPAT_NEWFSTATAT) ", %edi\n"
    "    je 1f\n"
#endif
#ifdef SYS_openat
    "    cmpl $" BN_ASM_STR(SYS_openat) ", %edi\n"
    "    je 1f\n"
#endif
#ifdef SYS_readlinkat
    "    cmpl $" BN_ASM_STR(SYS_readlinkat) ", %edi\n"
    "    je 1f\n"
#endif
#ifdef SYS_readlink
    "    cmpl $" BN_ASM_STR(SYS_readlink) ", %edi\n"
    "    je 1f\n"
#endif
    "    movq bn_compat_real_syscall(%rip), %r11\n"
    "    testq %r11, %r11\n"
    "    jz bn_compat_syscall_raw\n"
    "    jmp *%r11\n"
    "1:  jmp bn_compat_syscall_dispatch\n"
    ".size syscall, .-syscall\n"
    ".p2align 4\n"
    ".type bn_compat_syscall_raw,@function\n"
    "bn_compat_syscall_raw:\n"
    "    pushq %rbx\n"
    "    movq %rdi, %rax\n"
    "    movq %rsi, %rdi\n"
    "    movq %rdx, %rsi\n"
    "    movq %rcx, %rdx\n"
    "    movq %r8, %r10\n"
    "    movq %r9, %r8\n"
    "    movq 16(%rsp), %r9\n"
    "    syscall\n"
    "    cmpq $-4095, %rax\n"
    "    jl 2f\n"
    "    testq %rax, %rax\n"
    "    jns 2f\n"
    "    negq %rax\n"
    "    movq %rax, %rbx\n"
    "    call __errno_location@PLT\n"
    "    movl %ebx, (%rax)\n"
    "    movq $-1, %rax\n"
    "2:  popq %rbx\n"
    "    ret\n"
    ".size bn_compat_syscall_raw, .-bn_compat_syscall_raw\n"
);
#else
__asm__(
    ".text\n"
    ".p2align 4\n"
    ".globl syscall\n"
    ".type syscall,%function\n"
    "syscall:\n"
#ifdef SYS_statx
    "    mov x9, #" BN_ASM_STR(SYS_statx) "\n"
    "    cmp x0, x9\n"
    "    b.eq 1f\n"
#endif
#ifdef BN_COMPAT_NEWFSTATAT
    "    mov x9, #" BN_ASM_STR(BN_COMPAT_NEWFSTATAT) "\n"
    "    cmp x0, x9\n"
    "    b.eq 1f\n"
#endif
#ifdef SYS_openat
    "    mov x9, #" BN_ASM_STR(SYS_openat) "\n"
    "    cmp x0, x9\n"
    "    b.eq 1f\n"
#endif
#ifdef SYS_readlinkat
    "    mov x9, #" BN_ASM_STR(SYS_readlinkat) "\n"
    "    cmp x0, x9\n"
    "    b.eq 1f\n"
#endif
#ifdef SYS_readlink
    "    mov x9, #" BN_ASM_STR(SYS_readlink) "\n"
    "    cmp x0, x9\n"
    "    b.eq 1f\n"
#endif
    "    adrp x9, bn_compat_real_syscall\n"
    "    ldr x9, [x9, #:lo12:bn_compat_real_syscall]\n"
    "    cbz x9, bn_compat_syscall_raw\n"
    "    br x9\n"
    "1:  b bn_compat_syscall_dispatch\n"
    ".size syscall, .-syscall\n"
    ".p2align 4\n"
    ".type bn_compat_syscall_raw,%function\n"
    "bn_compat_syscall_raw:\n"
    "    stp x29, x30, [sp, #-32]!\n"
    "    mov x29, sp\n"
    "    str x19, [sp, #16]\n"
    "    mov x8, x0\n"
    "    mov x0, x1\n"
    "    mov x1, x2\n"
    "    mov x2, x3\n"
    "    mov x3, x4\n"
    "    mov x4, x5\n"
    "    mov x5, x6\n"
    "    svc 0\n"
    "    mov x19, #4095\n"
    "    neg x19, x19\n"
    "    cmp x0, x19\n"
    "    b.lo 2f\n"
    "    neg x19, x0\n"
    "    bl __errno_location\n"
    "    str w19, [x0]\n"
    "    mov x0, #-1\n"
    "2:  ldr x19, [sp, #16]\n"
    "    ldp x29, x30, [sp], #32\n"
    "    ret\n"
    ".size bn_compat_syscall_raw, .-bn_compat_syscall_raw\n"
);
#endif
