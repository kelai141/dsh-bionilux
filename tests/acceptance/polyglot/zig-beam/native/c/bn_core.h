#ifndef BN_CORE_H
#define BN_CORE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

int bn_c_add(int a, int b);
uint32_t bn_c_mix(uint32_t seed);
size_t bn_c_format(char *buf, size_t cap, int value);

#ifdef __cplusplus
}
#endif

#endif
