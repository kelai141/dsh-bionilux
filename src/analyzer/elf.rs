use goblin::Object;
use memmap2::MmapOptions;
use std::fs::File;
use std::path::Path;

pub const EM_X86_64: u16 = 0x3E;
pub const EM_AARCH64: u16 = 0xB7;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Libc {
    Bionic,
    Glibc,
    Musl,
    Static,
    Other,
}

pub struct ElfInfo {
    pub machine: u16,
    pub libc: Libc,
    pub interpreter: Option<String>,
}

// Parse ELF header + PT_INTERP via mmap. None for non-ELF or I/O error.
pub fn analyze<P: AsRef<Path>>(path: P) -> Option<ElfInfo> {
    let file = File::open(path).ok()?;
    let mmap = unsafe { MmapOptions::new().map(&file).ok()? };
    let elf = match Object::parse(&mmap).ok()? {
        Object::Elf(e) => e,
        _ => return None,
    };

    let interpreter = elf.interpreter.map(String::from);
    let libc = match interpreter.as_deref() {
        None => Libc::Static,
        Some(p) if p.contains("ld-musl") => Libc::Musl,
        Some("/system/bin/linker64") => Libc::Bionic,
        Some(p) if p.contains("ld-linux") => Libc::Glibc,
        Some(_) => Libc::Other,
    };

    Some(ElfInfo {
        machine: elf.header.e_machine,
        libc,
        interpreter,
    })
}
