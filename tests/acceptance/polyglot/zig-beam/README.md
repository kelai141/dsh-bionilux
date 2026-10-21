# Zig + Rust + C and BEAM acceptance fixture

This directory holds the reproduction for the two open acceptance items:

1. zig-clap and zalgebra were built with Zig 0.15.2/0.16.0 while their
   build.zig.zon manifests require Zig 0.17.0. The mismatch shows up as
   std API errors (pointer_stability, Struct.FieldAttributes, @backingInt),
   not as a runtime defect.
2. Cowboy was tested with rebar3 eunit. Cowboy builds with erlang.mk,
   which compiles test/ recursively; the rebar3 test profile only added
   test/, so modules in test/handlers/ were absent.

The fixture builds a real C ABI chain:

    Zig --calls--> C
    Zig --calls--> Rust --calls--> C
    C   --calls--> Zig and Rust
    BEAM NIF (C) --calls--> Zig and Rust --calls--> C

native/build.sh builds the Rust staticlib, compiles bn_core.c with
zig cc, builds a Zig static library, links a C joint executable, and links
the same objects into an Erlang NIF. native/run.sh then runs the joint
executable and the Zig test binary.

beam/eunit_gate.escript calls eunit:test/2 and exits 2 when it returns
the error atom. beam/run_beam.sh runs that gate against the NIF tests and
against bn_failing_tests, so a standalone erl invocation cannot report a
failing EUnit run as success. run_beam.sh returns nonzero unless erlc
succeeds, the passing module exits 0, and the deliberate failure exits
exactly 2. bn_nif.erl is the module that loads the NIF; bn_nif_tests.erl
calls bn_nif:joint/2 and bn_nif:describe/0.

The build targets x86_64-linux-gnu.2.35. The device's libgcc_s references
GLIBC_2.34/2.35 symbols, so the older default target cannot link it.
Static Zig processes also receive relative build paths after chdir; absolute
guest paths are not translated for raw syscalls. This is a harness constraint,
not a claim that runtime path mapping was fixed.

For Cowboy itself, the upstream erlang.mk target works after supplying the
matching Erlang source headers and physical Go caches:

    cd /root/polyglot/projects/erlang-cowboy
    export GOPATH=$BASE/fixes-go GOMODCACHE=$BASE/fixes-go-mod
    export GOCACHE=$BASE/fixes-go-cache
    export GOTMPDIR=$BASE/fixes-go-tmp TMPDIR=$BASE/fixes-go-tmp
    MAKEFLAGS=-j2 make eunit

The packaged Erlang installation has no ssl/src headers. Extract the matching
erlang-src package and copy only ssl-11.2.12.1/src into the installed
ssl-11.2.12.1 directory; ERL_LIBS and -pa do not override code:lib_dir(ssl)
for an installed OTP application. This adds headers, not a package upgrade.
The CT suite is not executed by this command.

The guest's static Go resolver cannot use the DNS hooks, so h2spec module
downloads need a temporary CONNECT proxy reachable at 127.0.0.1, for example
an adb reverse to the host. With HTTPS_PROXY/HTTP_PROXY set, ALL_PROXY empty,
SSL_CERT_FILE pointing at the physical rootfs ca-certificates.crt, physical
Go caches, and GOPROXY=https://goproxy.cn, h2spec builds and runs, and plain
make eunit reports 176 passed without the h2spec error. This changes no DNS
or system settings and is not part of the persistent environment.

If the Erlang source headers are unavailable, the CT-only dependencies can be
skipped with TEST_DEPS=; eunit still compiles test/ recursively, including
test/handlers.

If the rebar3 path is required, beam/rebar-cowboy.config can be selected
with REBAR_CONFIG; it adds test/handlers to the test profile without
editing upstream tests.

Version selection is checked against build.zig.zon rather than guessed.
Zig 0.17.0 is the first release satisfying both minimum_zig_version
declarations:

    curl -fL -o zig-0.17.0.tar.xz \
      https://ziglang.org/download/0.17.0/zig-x86_64-linux-0.17.0.tar.xz
    echo '1cbe9df9f27e6b78d14ccbca43b6703a404ef79ef1c463de901d7f088d4e2026  zig-0.17.0.tar.xz' | sha256sum -c -
    tar -xJf zig-0.17.0.tar.xz

Push the directory and run through the device launcher:

    adb push tests/acceptance/polyglot/zig-beam \
      /data/data/com.dsharnessmobile.shell/files/bn-work/polyglot/zig-beam
    adb shell 'export BIONILUX_RUNTIME_DIR=/data/data/com.dsharnessmobile.shell/files/bnrt \
      BIONILUX_PRELOAD=/data/data/com.dsharnessmobile.shell/files/bn-work/polyglot/fixes-preload-final.so; \
      /data/data/com.dsharnessmobile.shell/files/bn-work/polyglot/fixes-bionilux3 \
      --rootfs /data/data/com.dsharnessmobile.shell/files/bnrt/rootfs \
      --host-path /data/data/com.dsharnessmobile.shell --guest-cwd / \
      /bin/bash /data/data/com.dsharnessmobile.shell/files/bn-work/polyglot/zig-beam/run_device.sh'

run_device.sh runs one Zig compilation at a time and one Rust build, and
never edits the upstream checkouts.
