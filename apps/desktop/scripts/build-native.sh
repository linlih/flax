#!/bin/sh
# 编译 macOS 翻译小助手（native/translate/main.swift），输出 native/out/flax-translate（Apple 芯片和 Intel 通用）。
# 需要 Xcode 26 或更新（macOS 26 的 Translation 框架）。没有 Xcode 时跳过：Flax 照样能用，只是没有系统翻译。
set -e
cd "$(dirname "$0")/.."
[ "$(uname)" = "Darwin" ] || { echo "不是 macOS，跳过系统翻译小助手"; exit 0; }
command -v swiftc >/dev/null 2>&1 || { echo "没有 swiftc（装 Xcode 才有），跳过系统翻译小助手"; exit 0; }
SRC=native/translate/main.swift
OUT=native/out/flax-translate
mkdir -p native/out
if [ -f "$OUT" ] && [ "$OUT" -nt "$SRC" ]; then exit 0; fi
for arch in arm64 x86_64; do
  swiftc -parse-as-library -O -target "$arch-apple-macos26.0" "$SRC" -o "native/out/flax-translate-$arch"
done
lipo -create native/out/flax-translate-arm64 native/out/flax-translate-x86_64 -output "$OUT"
rm -f native/out/flax-translate-arm64 native/out/flax-translate-x86_64
echo "系统翻译小助手：$OUT"
