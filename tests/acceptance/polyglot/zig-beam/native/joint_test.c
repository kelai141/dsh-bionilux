#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "bn_core.h"

extern int bn_zig_compute(int x);
extern uint32_t bn_zig_mix(uint32_t seed);
extern size_t bn_zig_describe(char *buf, size_t cap);
extern int bn_rust_roundtrip(int a, int b);
extern uint32_t bn_rust_mix(uint32_t seed);
extern size_t bn_rust_describe(char *buf, size_t cap);

static int failures;

static void check_int(const char *name, long got, long want) {
    if (got == want) {
        printf("ok %s=%ld\n", name, got);
    } else {
        printf("FAIL %s got=%ld want=%ld\n", name, got, want);
        failures++;
    }
}

static void check_text(const char *name, const char *got, const char *want) {
    if (strcmp(got, want) == 0) {
        printf("ok %s=%s\n", name, got);
    } else {
        printf("FAIL %s got=%s want=%s\n", name, got, want);
        failures++;
    }
}

int main(void) {
    char buf[64] = {0};
    uint32_t seed = 0x12345678u;

    check_int("c_add", bn_c_add(20, 22), 42);
    check_int("rust_roundtrip", bn_rust_roundtrip(20, 22), 85);
    check_int("zig_compute", bn_zig_compute(1), 87);
    check_int("rust_mix", (long)(bn_rust_mix(seed) ^ 0x5a5a5a5au), (long)bn_c_mix(seed));
    check_int("zig_mix", (long)bn_zig_mix(seed), 0x5a5a5a5al);

    check_int("rust_describe_len", (long)bn_rust_describe(buf, sizeof buf), 10);
    check_text("rust_describe", buf, "rust(c:85)");
    memset(buf, 0, sizeof buf);
    check_int("zig_describe_len", (long)bn_zig_describe(buf, sizeof buf), 10);
    check_text("zig_describe", buf, "rust(c:85)");

    if (failures != 0) {
        printf("JOINT_FAILURES=%d\n", failures);
        return 1;
    }
    printf("JOINT_OK\n");
    return 0;
}
