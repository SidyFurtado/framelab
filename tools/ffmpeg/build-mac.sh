#!/bin/bash
#
# O FFmpeg do Mac, compilado aqui em LGPL (v3): universal (arm64 + x86_64),
# com VideoToolbox para o H.264 e nenhuma biblioteca GPL ou nonfree.
#
#   tools/ffmpeg/build-mac.sh <versão> <saída>
#
# Sai em <saída>: o binário universal `ffmpeg`, o tarball do código-fonte
# exato e BUILD-macos.txt com a configuração (o que a página de licenças
# de terceiros publica). Roda no CI (.github/workflows/ffmpeg-lgpl.yml).
#
# O que garante que é LGPL, e portátil, e não só "parece":
#   • --disable-autodetect: nada da máquina de build entra por acaso (uma
#     lib do Homebrew linkada aqui não existe no Mac do editor);
#   • a conferência no fim recusa --enable-gpl/--enable-nonfree, exige
#     "Lesser" no -L e só aceita links para /usr/lib e /System.
set -euo pipefail

VERSION="${1:?versão, ex.: 9.0.2}"
OUT="$(mkdir -p "${2:?pasta de saída}" && cd "$2" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
MIN_MACOS="11.0"

# As flags publicadas na página de licenças (src/legal/thirdParty.ts confere
# que são estas, palavra por palavra).
FLAGS=(
  --disable-gpl --disable-nonfree --enable-version3
  --disable-autodetect --enable-videotoolbox --enable-audiotoolbox
  --enable-zlib --enable-bzlib
  --disable-ffplay --disable-ffprobe --disable-doc --disable-debug
)

TARBALL="ffmpeg-${VERSION}.tar.xz"
curl -fsSL --retry 3 -o "$OUT/$TARBALL" "https://ffmpeg.org/releases/${TARBALL}"
tar -xf "$OUT/$TARBALL" -C "$WORK"
SRC="$WORK/ffmpeg-${VERSION}"

build() {
  local arch="$1" dir="$WORK/build-$1"
  local extra=()
  if [ "$arch" != "$(uname -m)" ]; then
    extra=(--enable-cross-compile --arch="$arch" --target-os=darwin)
  fi
  if [ "$arch" = x86_64 ] && ! command -v nasm >/dev/null 2>&1; then
    # O CI instala o nasm; sem ele, sai sem o assembly x86 (mais lento).
    echo "aviso: sem nasm, x86_64 sem assembly" >&2
    extra+=(--disable-x86asm)
  fi
  mkdir -p "$dir"
  (
    cd "$dir"
    "$SRC/configure" "${FLAGS[@]}" ${extra[@]+"${extra[@]}"} \
      --cc="clang -arch $arch" \
      --extra-cflags="-mmacosx-version-min=$MIN_MACOS" \
      --extra-ldflags="-arch $arch -mmacosx-version-min=$MIN_MACOS" \
      >"$dir/configure.log" 2>&1 || { tail -40 "$dir/configure.log"; exit 1; }
    make -j"$(sysctl -n hw.ncpu)" ffmpeg >"$dir/make.log" 2>&1 || { tail -60 "$dir/make.log"; exit 1; }
  )
}

build arm64
build x86_64
lipo -create "$WORK/build-arm64/ffmpeg" "$WORK/build-x86_64/ffmpeg" -output "$OUT/ffmpeg"
chmod 755 "$OUT/ffmpeg"
codesign --force --sign - "$OUT/ffmpeg"

# ── a conferência ────────────────────────────────────────────────────
FF="$OUT/ffmpeg"
lipo -archs "$FF" | grep -q arm64 && lipo -archs "$FF" | grep -q x86_64 || { echo "não saiu universal" >&2; exit 1; }
if "$FF" -hide_banner -buildconf | grep -Eq -- '--enable-(gpl|nonfree)'; then
  echo "build com GPL/nonfree — recusado" >&2; exit 1
fi
"$FF" -hide_banner -L | grep -q "Lesser General Public License" || { echo "a licença não é LGPL" >&2; exit 1; }
"$FF" -hide_banner -encoders | grep -q h264_videotoolbox || { echo "sem h264_videotoolbox" >&2; exit 1; }
# Só as linhas de dependência (recuadas); os cabeçalhos "(architecture …)"
# do binário universal não contam.
if otool -L "$FF" | grep -E '^[[:space:]]' | grep -Ev '^[[:space:]]+(/usr/lib/|/System/)'; then
  echo "link para fora do sistema (acima) — o binário não seria portátil" >&2; exit 1
fi

{
  echo "FFmpeg ${VERSION} — Framelab, macOS universal (arm64 + x86_64)"
  echo "Licença: LGPL-3.0-or-later"
  echo "Código-fonte: https://ffmpeg.org/releases/${TARBALL} (cópia na mesma release: ${TARBALL})"
  echo "Configuração: ${FLAGS[*]}"
  echo "Compilado por: tools/ffmpeg/build-mac.sh (macOS mínimo ${MIN_MACOS})"
  echo
  "$FF" -hide_banner -version
} >"$OUT/BUILD-macos.txt"

(cd "$OUT" && rm -f "ffmpeg-${VERSION}-lgpl-macos-universal.zip" && zip -q "ffmpeg-${VERSION}-lgpl-macos-universal.zip" ffmpeg)
echo "ok: $OUT/ffmpeg-${VERSION}-lgpl-macos-universal.zip"
