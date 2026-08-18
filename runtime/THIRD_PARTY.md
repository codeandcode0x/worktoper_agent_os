# Bundled runtime components

The desktop packages include only the runtime directory for their target operating system.

| Component | Platform | Version/source | License |
| --- | --- | --- | --- |
| Electron | macOS, Windows, Linux x86_64 | Electron 43.3.0 official distributions | MIT; each distribution includes `LICENSE` and Chromium notices |
| QEMU | macOS x86_64 | Homebrew bottle, QEMU 11.0.1 | GPL-2.0-only; bundled `COPYING` and `COPYING.LIB` |
| QEMU | Windows x86_64 | Stefan Weil's QEMU for Windows build, QEMU 11.1.0 (2026-08-11) | GPL-2.0-only; bundled `COPYING` and `COPYING.LIB` |
| QEMU | Linux x86_64 | Alpine Linux 3.22 package, QEMU 10.0.0 | GPL-2.0-only; bundled `COPYING` and `COPYING.LIB` |
| tar | macOS x86_64 | libarchive 3.8.1 source build | BSD; bundled `LIBARCHIVE-LICENSE` |
| tar | Windows x86_64 | busybox-w32 commit `6dd3b19ec848b04a38c2564937e54c1a3c37ab1a` | GPL-2.0; bundled `BUSYBOX-LICENSE` |
| tar | Linux x86_64 | BusyBox 1.35.0 static musl build from busybox.net | GPL-2.0; bundled `BUSYBOX-LICENSE` |

Windows QEMU is downloaded from `https://qemu.weilnetz.de/w64/`. Linux QEMU and its musl dependency closure are extracted from the official Alpine Linux repositories. The Linux static launchers invoke the bundled musl loader explicitly, so the host distribution does not need a compatible QEMU or shared-library installation.

The macOS QEMU bundle is generated with `node scripts/bundle-macos-runtime.mjs`. The script copies the QEMU executables, their complete non-system dynamic-library closure, and required x86 firmware, then rewrites Homebrew paths to loader-relative paths. The distributable macOS tar is generated with `scripts/bundle-macos-tar.sh`; copying Apple's protected `/usr/bin/bsdtar` is not supported by macOS.
