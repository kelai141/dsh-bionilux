#include "bn_core.h"

#include <stdio.h>

int bn_c_add(int a, int b) { return a + b; }

uint32_t bn_c_mix(uint32_t seed) {
    uint32_t x = seed * 1664525u + 1013904223u;
    x ^= x >> 16;
    x *= 2246822519u;
    x ^= x >> 13;
    return x;
}

size_t bn_c_format(char *buf, size_t cap, int value) {
    int n;

    if (buf == NULL || cap == 0) {
        return 0;
    }
    n = snprintf(buf, cap, "c:%d", value);
    return n < 0 ? 0 : (size_t)n;
}
