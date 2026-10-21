const std = @import("std");

extern fn bn_c_add(a: c_int, b: c_int) c_int;
extern fn bn_c_mix(seed: u32) u32;
extern fn bn_rust_roundtrip(a: c_int, b: c_int) c_int;
extern fn bn_rust_mix(seed: u32) u32;
extern fn bn_rust_describe(buf: [*]u8, cap: usize) usize;

/// Zig -> C and Zig -> Rust -> C in one call.
export fn bn_zig_compute(x: c_int) c_int {
    return bn_c_add(x, 1) + bn_rust_roundtrip(20, 22);
}

export fn bn_zig_mix(seed: u32) u32 {
    return bn_c_mix(seed) ^ bn_rust_mix(seed);
}

export fn bn_zig_describe(buf: [*]u8, cap: usize) usize {
    return bn_rust_describe(buf, cap);
}

test "C, Rust and Zig agree through the C ABI" {
    try std.testing.expectEqual(@as(c_int, 5), bn_c_add(2, 3));
    try std.testing.expectEqual(@as(c_int, 85), bn_rust_roundtrip(20, 22));
    try std.testing.expectEqual(@as(c_int, 87), bn_zig_compute(1));

    const seed: u32 = 0x12345678;
    try std.testing.expectEqual(bn_c_mix(seed) ^ 0x5a5a5a5a, bn_rust_mix(seed));
    try std.testing.expectEqual(@as(u32, 0x5a5a5a5a), bn_zig_mix(seed));
}
