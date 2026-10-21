const std = @import("std");
const bn = @import("bn_zig.zig");

pub fn main() !void {
    std.debug.print("zig_rust_c={d}\n", .{bn.bn_zig_compute(1)});
}
