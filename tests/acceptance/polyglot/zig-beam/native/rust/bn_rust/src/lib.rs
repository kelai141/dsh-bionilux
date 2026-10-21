//! Rust half of the mixed C ABI fixture.
//!
//! The C functions are deliberately unresolved in this static library. They
//! are supplied by bn_core.c when the Zig test, the C joint test, or the NIF
//! is linked. That keeps the call chain real instead of stubbing C out.

use std::ffi::CStr;
use std::os::raw::{c_char, c_int};

extern "C" {
    fn bn_c_add(a: c_int, b: c_int) -> c_int;
    fn bn_c_mix(seed: u32) -> u32;
    fn bn_c_format(buf: *mut c_char, cap: usize, value: c_int) -> usize;
}

#[no_mangle]
pub extern "C" fn bn_rust_roundtrip(a: c_int, b: c_int) -> c_int {
    let sum = unsafe { bn_c_add(a, b) };
    sum.wrapping_mul(2).wrapping_add(1)
}

#[no_mangle]
pub extern "C" fn bn_rust_mix(seed: u32) -> u32 {
    (unsafe { bn_c_mix(seed) }) ^ 0x5a5a_5a5a
}

#[no_mangle]
pub extern "C" fn bn_rust_describe(buf: *mut c_char, cap: usize) -> usize {
    let mut cbuf = [0 as c_char; 64];

    if buf.is_null() || cap == 0 {
        return 0;
    }
    let value = bn_rust_roundtrip(20, 22);
    let n = unsafe { bn_c_format(cbuf.as_mut_ptr(), cbuf.len(), value) };
    if n == 0 || n >= cbuf.len() {
        return 0;
    }
    let text = unsafe { CStr::from_ptr(cbuf.as_ptr()) }.to_string_lossy();
    let rendered = format!("rust({text})");
    let bytes = rendered.as_bytes();
    let n = bytes.len().min(cap - 1);

    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), buf as *mut u8, n);
        *buf.add(n) = 0;
    }
    n
}
