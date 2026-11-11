# DSH Mobile compatibility — Bionilux 0.10.0

**0.10.0 does not guarantee that an existing DSH Mobile APK can install and run Linux.** Satisfying `minMobileVersion` is not proof that the APK ships a compatible native glibc loader. A backend/rootfs download cannot install an executable APK-native file into an existing APK.

## Prerequisites and evidence boundary

| Item | Requirement / current evidence |
| --- | --- |
| Host ABI | 64-bit Android host Node: `process.arch` must be `arm64` or `x64`. Launcher, rootfs, Node, preload and loader must match. No ARM32/x86-32 support or translation; 64-bit hardware alone is insufficient if the host engine is 32-bit. |
| Android floor | Launcher CI uses NDK API **24** (binary build floor, not product validation). The reviewed APK has **minSdk 26**. Neither API24 nor API26 full one-click operation is established here. |
| Mobile version | Install and cold restore check manifest minimum semantic version and ABI. Current workflow minimum is `0.14.0`; this does not test loader availability. Existing 0.14.x/DEV APKs are not automatically compatible. |
| Native loader | APK must install the matching 64-bit `libbionilux-loader.so` in `ApplicationInfo.nativeLibraryDir`. Pin it to the **same glibc/rootfs release** as the guest, with version/source/SHA-256 provenance. Architecture equality alone does not prove glibc compatibility; app and Linux updates must preserve this binding. |
| Loader wiring | Manager accepts explicit `nativeLibDir`, otherwise `DSH_NATIVE_LIB_DIR`, and exports `BIONILUX_NATIVE_LIB_DIR`. Empty configuration preserves rootfs fallback, not a promise that Android/SELinux allows app-data execution. |
| Measured device | Lead measured **emulator-5584, API29, x86_64, 4096-byte pages**: direct rescue Bash, `id -u` = 0, `uname`, `ls`, shared Node 24.22.0 passed. This is rescue-runtime evidence, **not** newly built release-APK or Settings one-click acceptance. The same device subsequently reported SELinux **Enforcing**. Current-source manager verification, tool registration and persistent export/reuse also passed with the newly compiled preload on the existing 0.5.0 instance; this is still not a clean 0.10.0 release installation. No API35+, ARM64 or actual 16KB-page pass is claimed. |

Sources: [launcher build](<../.github/workflows/debug-build.yml#L239-L269>), [host architecture selection](<../packages/linux-bootstrap/src/manifest.js#L14-L22>), [manager loader configuration](<../packages/linux-runtime/modules/manager.js#L767-L772>), [reviewed sibling APK settings](<D:/coding/dsh-mobile/dsh-mobile-apk/app/build.gradle.kts#L15-L32>). Local artifacts and reports belong under `target/independent-linux/`; final release/device validation is separate.

## APK loader staging — required, not implicit

The sibling [Gradle configuration](<D:/coding/dsh-mobile/dsh-mobile-apk/app/build.gradle.kts#L232-L242>) includes the loader in the **main** source set and enables legacy native extraction only when `nativeLinuxLoaderDir` is supplied. [The build driver](<D:/coding/dsh-mobile/dsh-mobile-apk/scripts/build-apk.mjs#L504-L515>) explicitly allows no-loader APK builds when `DSH_NATIVE_LINUX_LOADER_DIR` is absent. A green default APK build is therefore not Linux compatibility evidence.

Prepare release-matched, checksum-verified loader inputs outside tracked source. Accepted names: `arm64-v8a/libbionilux-loader.so` and `x86_64/libbionilux-loader.so`, or release assets `bionilux-loader-aarch64.so` / `bionilux-loader-x86_64.so`. Never fill one ABI slot with the other ABI bytes.

These are **release-operator commands, not actions executed in this task**. Set `$loaders` to the verified input directory and replace final APK placeholders with actual newly built files. Run APK builds from the APK checkout with prepared snapshots/build tools. Linux compilation and ELF checks must use the independent Debian guest, not WSL.

```powershell
$apkRoot = 'D:\coding\dsh-mobile\dsh-mobile-apk'
$loaders = 'D:\coding\dsh-bionilux\target\independent-linux\mobile-loader-input'
Set-Location -LiteralPath $apkRoot
node "$apkRoot/scripts/check-native-linux-loader.mjs" --source $loaders --abi arm64 --stage "D:/coding/dsh-bionilux/target/independent-linux/mobile-loader-stage-arm64"
if ($LASTEXITCODE -ne 0) { throw 'ARM64 loader input rejected' }
node "$apkRoot/scripts/check-native-linux-loader.mjs" --source $loaders --abi x86_64 --stage "D:/coding/dsh-bionilux/target/independent-linux/mobile-loader-stage-x86_64"
if ($LASTEXITCODE -ne 0) { throw 'x86_64 loader input rejected' }

# Each build internally stages only the selected ABI.
pwsh -NoProfile -File "$apkRoot/scripts/build-apk-013.ps1" -Suffix '' -OnlyAbi arm64 -NativeLinuxLoaderDir $loaders
if ($LASTEXITCODE -ne 0) { throw 'ARM64 APK build failed' }
pwsh -NoProfile -File "$apkRoot/scripts/build-apk-013.ps1" -Suffix '' -OnlyAbi x86_64 -NativeLinuxLoaderDir $loaders
if ($LASTEXITCODE -ne 0) { throw 'x86_64 APK build failed' }

node "$apkRoot/scripts/check-native-linux-loader.mjs" --apk '<new-arm64-release.apk>' --abi arm64 --require
if ($LASTEXITCODE -ne 0) { throw 'ARM64 final APK rejected' }
node "$apkRoot/scripts/check-native-linux-loader.mjs" --apk '<new-x86_64-release.apk>' --abi x86_64 --require
if ($LASTEXITCODE -ne 0) { throw 'x86_64 final APK rejected' }
```

Source contracts: [entry parameters](<D:/coding/dsh-mobile/dsh-mobile-apk/scripts/build-apk-013.ps1#L4-L15>), [per-ABI staging](<D:/coding/dsh-mobile/dsh-mobile-apk/scripts/build-apk-engine.mjs#L190-L214>), [final APK check before delivery](<D:/coding/dsh-mobile/dsh-mobile-apk/scripts/build-apk-engine.mjs#L242-L255>), [gate CLI](<D:/coding/dsh-mobile/dsh-mobile-apk/scripts/check-native-linux-loader.mjs#L272-L278>), [engine environment export](<D:/coding/dsh-mobile/dsh-mobile-apk/app/src/main/java/com/dsharnessmobile/shell/EngineManager.kt#L3011-L3017>). Absolute links identify reviewed local sibling sources, not published-artifact proof.

## One-click lifecycle and honest health

1. User explicitly confirms install in Android Settings. The [client](<../packages/linux-bootstrap/client/index.js>) selects host ABI, obtains the manifest and asks native host preparation to stage plugin/backend/rootfs/Node. Native preparation verifies/stages bytes; it does not activate Linux.
2. [Bootstrap](<../packages/linux-bootstrap/src/index.js>) verifies manifest/version/ABI and plugin bytes, loads the runtime through the host, provisions it, then awaits **manager.verify()**. Missing verification support, spawn error, timeout or unhealthy verdict fails closed. Host plugin membership alone cannot persist enabled/activated success.
3. The [manager probe](<../packages/linux-runtime/modules/manager.js#L1068-L1097>) executes real **Bash**, external `id`, `uname`, `ls` and shared `node --version`, requiring guest UID 0 and an exact completion marker. The [runtime plugin](<../packages/linux-runtime/lib/index.js>) gates registration on verification. Static files or working shell builtins are not usability proof.
4. Cold restore rechecks the pinned manifest against current app version/ABI and requires proof in the new process. Manual plugin removal stays removed. Engine shutdown ends sessions/jobs but retains installed guest files; restart must not silently reinstall or erase the work directory.
5. [Standalone acceptance](<../tests/acceptance/standalone-device.mjs>) records `installation` separately from `acceptance`. `--serve` may retain an independently smoke-proven usable runtime after optional session-assertion failure, but reports `acceptance.passed:false`. Explicit `--install`/acceptance failures remain nonzero. The [startup script](<../scripts/start-independent-linux.ps1>) requires live readiness, installation proof, healthy manager and registered `linux_bash`; optional acceptance failure is a warning. This process/HTTP harness is **not** Android Settings/UI acceptance.

The reviewed [extractor](<D:/coding/dsh-mobile/dsh-mobile-apk/app/src/main/java/com/dsharnessmobile/shell/LinuxAssetExtractor.kt#L206-L231>) uses [SnapshotFileMode](<D:/coding/dsh-mobile/dsh-mobile-apk/app/src/main/java/com/dsharnessmobile/shell/SnapshotFileMode.kt#L12-L21>), accepting both ELF **and shebang scripts**. An ELF-only/script-chmod defect was not established; no blanket runtime chmod workaround is justified.

## 4KB / 16KB validation boundary

- The sibling loader gate checks 64-bit ELF class/machine, correct APK ABI, stored loader entry and absence of a foreign-ABI loader. [It reads only ELF headers](<D:/coding/dsh-mobile/dsh-mobile-apk/scripts/check-native-linux-loader.mjs#L72-L112>), **not PT_LOAD layout**; it cannot establish 16KB support.
- This repository's [ELF checker](<../scripts/check_elf_alignment.py>) uses `--policy android --page-size 16384 --machine aarch64` (or `x86_64`) for Android-loaded objects: PT_LOAD alignment and offset/address congruence are prerequisites. Guest loader/preload/rootfs/Node use separate `--policy guest` checks: low `p_align` alone is not a glibc verdict. Check the exact packaged bytes, not unrelated development binaries.
- 16KB linker flags and passing static ELF reports are **not** actual device passes. APK-native loader, guest dependencies, glibc page assumptions, native extraction/ZIP policy, SELinux and command/session operation remain end-to-end gates. A 4KB API29 rescue pass does not cover 16KB, newer Android policy or ARM64.

**Release boundary:** each actual APK/ABI must carry its pinned loader and pass app-UID one-click install, restart/registration and command/session checks on its intended Android/page-size matrix. Until then, describe those combinations as unverified prerequisites, not supported-device results.
