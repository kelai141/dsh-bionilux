#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::process::{Command, Output};

fn launch(path: &std::path::Path, name: &str) -> Output {
    Command::new(env!("CARGO_BIN_EXE_bionilux"))
        .env_clear()
        .env("PATH", path)
        .arg("--no-preload")
        .arg(name)
        .output()
        .unwrap()
}

#[test]
fn path_lookup_distinguishes_denied_from_missing_commands() {
    let tmp = tempfile::tempdir().unwrap();
    let denied = tmp.path().join("denied");
    std::fs::write(&denied, b"#!/bin/sh\nexit 0\n").unwrap();
    std::fs::set_permissions(&denied, std::fs::Permissions::from_mode(0o644)).unwrap();
    std::fs::create_dir(tmp.path().join("directory")).unwrap();

    for name in ["denied", "directory"] {
        let output = launch(tmp.path(), name);
        assert_eq!(output.status.code(), Some(126), "{name}: {output:?}");
        assert!(String::from_utf8_lossy(&output.stderr).contains("permission denied"));
    }
    for name in ["missing", ""] {
        assert_eq!(launch(tmp.path(), name).status.code(), Some(127));
    }
}

#[test]
fn path_lookup_continues_after_a_denied_candidate() {
    let tmp = tempfile::tempdir().unwrap();
    let first = tmp.path().join("first");
    let second = tmp.path().join("second");
    std::fs::create_dir(&first).unwrap();
    std::fs::create_dir(&second).unwrap();
    let denied = first.join("tool");
    std::fs::write(&denied, b"not executable\n").unwrap();
    std::fs::set_permissions(&denied, std::fs::Permissions::from_mode(0o644)).unwrap();
    std::os::unix::fs::symlink("/bin/true", second.join("tool")).unwrap();
    let path = std::env::join_paths([first, second]).unwrap();

    let output = launch(std::path::Path::new(&path), "tool");
    assert!(output.status.success(), "{output:?}");
}

#[test]
fn guest_path_lookup_reports_denied_without_falling_back_to_host() {
    let tmp = tempfile::tempdir().unwrap();
    let bin = tmp.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    let denied = bin.join("sh");
    std::fs::write(&denied, b"#!/bin/sh\n").unwrap();
    std::fs::set_permissions(&denied, std::fs::Permissions::from_mode(0o644)).unwrap();

    for (name, code) in [("sh", 126), ("missing", 127), ("", 127)] {
        let output = Command::new(env!("CARGO_BIN_EXE_bionilux"))
            .env_clear()
            .env("PATH", "/bin:/usr/bin")
            .arg("--rootfs")
            .arg(tmp.path())
            .args(["--guest-path", "/bin", name])
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(code), "{name}: {output:?}");
    }
}
