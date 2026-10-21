#include <erl_nif.h>
#include <stdint.h>
#include <string.h>

#include "bn_core.h"

extern int bn_zig_compute(int x);
extern uint32_t bn_zig_mix(uint32_t seed);
extern int bn_rust_roundtrip(int a, int b);
extern size_t bn_rust_describe(char *buf, size_t cap);

static ERL_NIF_TERM joint(ErlNifEnv *env, int argc, const ERL_NIF_TERM argv[]) {
    int a;
    int b;
    int zig;
    int rust;

    if (argc != 2 || !enif_get_int(env, argv[0], &a) || !enif_get_int(env, argv[1], &b)) {
        return enif_make_badarg(env);
    }
    zig = bn_zig_compute(a);
    rust = bn_rust_roundtrip(a, b);
    return enif_make_int(env, zig + rust + (int)(bn_zig_mix((uint32_t)b) & 0x7f));
}

static ERL_NIF_TERM describe(ErlNifEnv *env, int argc, const ERL_NIF_TERM argv[]) {
    char buf[64] = {0};

    (void)argc;
    (void)argv;
    if (bn_rust_describe(buf, sizeof buf) == 0) {
        return enif_make_badarg(env);
    }
    return enif_make_string(env, buf, ERL_NIF_LATIN1);
}

static ErlNifFunc nif_funcs[] = {
    {"joint", 2, joint, 0},
    {"describe", 0, describe, 0},
};

ERL_NIF_INIT(bn_nif, nif_funcs, NULL, NULL, NULL, NULL)
