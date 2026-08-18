#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
build_root=$(mktemp -d "${TMPDIR:-/tmp}/worktoper-libarchive.XXXXXX")
archive_version=3.8.1
archive_url="https://www.libarchive.org/downloads/libarchive-${archive_version}.tar.xz"
output_dir="$project_root/runtime/tools/darwin"
xz_prefix=$(brew --prefix xz)

trap 'rm -rf "$build_root"' EXIT
mkdir -p "$build_root/source" "$output_dir/lib"
curl -fL --retry 3 -o "$build_root/libarchive.tar.xz" "$archive_url"
/usr/bin/tar -xJf "$build_root/libarchive.tar.xz" -C "$build_root/source" --strip-components=1

cd "$build_root/source"
LDFLAGS="-L$xz_prefix/lib" CPPFLAGS="-I$xz_prefix/include" ./configure \
  --disable-shared \
  --enable-static \
  --without-openssl \
  --without-xml2 \
  --without-expat \
  --without-libb2 \
  --without-lz4 \
  --without-zstd \
  --without-lzo2
make -j"$(sysctl -n hw.logicalcpu)" bsdtar

cp bsdtar "$output_dir/tar"
cp COPYING "$output_dir/LIBARCHIVE-LICENSE"
cp "$xz_prefix/lib/liblzma.5.dylib" "$output_dir/lib/liblzma.5.dylib"
chmod 755 "$output_dir/tar" "$output_dir/lib/liblzma.5.dylib"
install_name_tool -change "$xz_prefix/lib/liblzma.5.dylib" '@loader_path/lib/liblzma.5.dylib' "$output_dir/tar"
install_name_tool -id '@loader_path/liblzma.5.dylib' "$output_dir/lib/liblzma.5.dylib"
codesign --force --sign - "$output_dir/lib/liblzma.5.dylib"
codesign --force --sign - "$output_dir/tar"
