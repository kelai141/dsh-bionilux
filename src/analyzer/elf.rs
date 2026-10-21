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
    /// Whether the file has a PT_DYNAMIC segment.
    ///
    /// A static executable does not, but a glibc loader does even though it
    /// has no PT_INTERP of its own. That distinction is what lets the launcher
    /// recognise a loader without mistaking every static binary for one.
    pub dynamic: bool,
    /// DT_RPATH entries. glibc ignores them when the same object also has
    /// DT_RUNPATH.
    pub rpath: Vec<String>,
    /// DT_RUNPATH entries.
    pub runpath: Vec<String>,
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
        dynamic: elf.dynamic.is_some(),
        rpath: split_search_path(&elf.rpaths),
        runpath: split_search_path(&elf.runpaths),
    })
}

/// Split an RPATH/RUNPATH value the way the loader does.
///
/// Each dynamic entry holds one colon separated list; an empty list means the
/// object asked for nothing, while an empty element inside a non-empty list
/// still means the current directory.
fn split_search_path(values: &[&str]) -> Vec<String> {
    values
        .iter()
        .filter(|value| !value.is_empty())
        .flat_map(|value| value.split(':'))
        .map(String::from)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_path_values_split_on_colons_and_empty_lists_ask_for_nothing() {
        assert!(split_search_path(&[]).is_empty());
        assert!(split_search_path(&[""]).is_empty());
        assert_eq!(split_search_path(&["/a:/b", "/c"]), ["/a", "/b", "/c"]);
        // An empty element inside a non-empty list still means the current
        // directory to the loader.
        assert_eq!(split_search_path(&["/a::/b"]), ["/a", "", "/b"]);
    }
}
