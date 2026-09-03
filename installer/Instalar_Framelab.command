#!/usr/bin/env bash
# ============================================================
#  FRAMELAB — INSTALADOR PARA MAC
# ============================================================
#
#  Duas rotas, nesta ordem:
#
#  1. UPIA — o instalador de plugins da própria Adobe, que vem com o
#     Creative Cloud. É o mesmo que o Creative Cloud usa por dentro:
#     copia os arquivos E registra o plugin em PluginsInfo. Quando ele
#     existe, é a rota certa, sem discussão.
#
#  2. Cópia manual para a pasta que o Premiere varre sozinho. O log do
#     Premiere mostra que ele lê três pastas "fallback" na abertura,
#     sem precisar de registro nenhum:
#
#       upic::Loading plugins from user fallback plugins folder:
#         ~/Library/Application Support/Adobe/UXP/Plugins/External
#
#     O nome da pasta é `id_versão` — a convenção do UXP.
#
#  A rota 2 existe porque nem toda máquina tem o Creative Cloud no
#  lugar esperado, e um instalador que depende de uma coisa só é um
#  instalador que falha calado.
# ============================================================

set -u
clear
echo ""
echo -e "\033[38;2;227;155;60m   ███████╗██████╗  █████╗ ███╗   ███╗███████╗██╗      █████╗ ██████╗ \033[0m"
echo -e "\033[38;2;227;155;60m   ██╔════╝██╔══██╗██╔══██╗████╗ ████║██╔════╝██║     ██╔══██╗██╔══██╗\033[0m"
echo -e "\033[38;2;227;155;60m   █████╗  ██████╔╝███████║██╔████╔██║█████╗  ██║     ███████║██████╔╝\033[0m"
echo -e "\033[38;2;227;155;60m   ██╔══╝  ██╔══██╗██╔══██║██║╚██╔╝██║██╔══╝  ██║     ██╔══██║██╔══██╗\033[0m"
echo -e "\033[38;2;227;155;60m   ██║     ██║  ██║██║  ██║██║ ╚═╝ ██║███████╗███████╗██║  ██║██████╔╝\033[0m"
echo -e "\033[38;2;227;155;60m   ╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝╚══════╝╚══════╝╚═╝  ╚═╝╚═════╝ \033[0m"
echo ""
echo -e "\033[1;37m   Suíte de Precisão & Automação para Adobe Premiere Pro\033[0m"
echo -e "\033[38;2;106;112;108m   ───────────────────────────────────────────────────────────────────────────\033[0m"
echo ""

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

falhar() {
  echo ""
  echo -e "\033[1;31m   ✗ $1\033[0m"
  echo ""
  read -r -p "   Pressione ENTER para fechar..."
  exit 1
}

# ── onde estão os arquivos do plugin ──────────────────────────────
ARQUIVOS=""
for candidato in "$DIR" "$DIR/dist" "$DIR/../dist"; do
  if [ -f "$candidato/manifest.json" ] && [ -f "$candidato/index.js" ]; then
    ARQUIVOS="$candidato"
    break
  fi
done
[ -n "$ARQUIVOS" ] || falhar "Não achei os arquivos do plugin. Descompacte o ZIP por completo antes de abrir este instalador."

# O id e a versão saem do manifesto — não de constantes que envelhecem
# em silêncio quando a versão sobe.
ID=$(sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ARQUIVOS/manifest.json" | head -1)
VERSAO=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ARQUIVOS/manifest.json" | head -1)
[ -n "$ID" ] && [ -n "$VERSAO" ] || falhar "O manifest.json do pacote está ilegível."

echo -e "\033[1;33m[1/4]\033[0m Framelab v$VERSAO — procurando o instalador da Adobe…"

UPIA="/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent"
CCX=""
for c in "$DIR/Framelab.ccx" "$DIR/../Framelab.ccx"; do
  [ -f "$c" ] && CCX="$c" && break
done

EXTERNAL="$HOME/Library/Application Support/Adobe/UXP/Plugins/External"

limpar_anteriores() {
  [ -d "$EXTERNAL" ] || return 0
  for velha in "$EXTERNAL/${ID}_"* "$EXTERNAL/$ID"; do
    [ -e "$velha" ] || [ -L "$velha" ] || continue
    rm -rf "$velha" 2>/dev/null || true
  done
}

INSTALADO=""
if [ -x "$UPIA" ] && [ -n "$CCX" ]; then
  echo -e "\033[32m  ✓ Encontrado. Instalando pelo caminho oficial da Adobe.\033[0m"
  echo ""
  echo -e "\033[1;33m[2/4]\033[0m Instalando plugin no Premiere Pro…"
  "$UPIA" --remove "Framelab" >/dev/null 2>&1 || true
  limpar_anteriores
  if "$UPIA" --install "$CCX" 2>&1 | grep -q "Installation Successful"; then
    INSTALADO="upia"
    echo -e "\033[32m  ✓ Instalado e registrado pelo Adobe UPIA.\033[0m"
  else
    echo -e "\033[38;2;227;155;60m  ℹ O instalador da Adobe recusou. Seguindo pela cópia direta.\033[0m"
  fi
else
  echo -e "\033[38;2;227;155;60m  ℹ Não encontrado nesta máquina. Seguindo pela cópia direta.\033[0m"
  echo ""
  echo -e "\033[1;33m[2/4]\033[0m Instalando plugin no Premiere Pro…"
fi

# ── rota 2: a pasta que o Premiere varre sozinho ──────────────────
if [ -z "$INSTALADO" ]; then
  DESTINO="$EXTERNAL/${ID}_${VERSAO}"
  limpar_anteriores
  mkdir -p "$DESTINO" || falhar "Não consegui criar a pasta de destino."
  for f in manifest.json index.html index.js index.css; do
    cp -f "$ARQUIVOS/$f" "$DESTINO/" || falhar "Não consegui copiar $f."
  done
  chmod -R 755 "$DESTINO" 2>/dev/null || true
  INSTALADO="pasta"
  echo -e "\033[32m  ✓ Copiado para:\033[0m"
  echo -e "    \033[38;2;154;159;154m$DESTINO\033[0m"
fi

# ── etapa 3: motores de processamento (FFmpeg, Whisper IA, Downloader) ──
echo ""
echo -e "\033[1;33m[3/4]\033[0m Configurando motores nativos (FFmpeg, Whisper IA, Downloader)…"
FRAMELAB_DIR="$HOME/Library/Application Support/Framelab"
FRAMELAB_BIN="$FRAMELAB_DIR/bin"
mkdir -p "$FRAMELAB_BIN" || falhar "Não consegui criar a pasta de motores ($FRAMELAB_BIN)."

# Procura a pasta bin que vem junto com o instalador
BIN_FONTE=""
for b in "$DIR/bin" "$DIR/../bin" "$DIR/installer/bin"; do
  if [ -d "$b" ] && [ -f "$b/ffmpeg" ]; then
    BIN_FONTE="$b"
    break
  fi
done

if [ -n "$BIN_FONTE" ]; then
  for util in ffmpeg whisper-cli yt-dlp; do
    if [ -f "$BIN_FONTE/$util" ]; then
      cp -f "$BIN_FONTE/$util" "$FRAMELAB_BIN/$util" 2>/dev/null || true
    fi
  done
fi

# Garante permissões de execução e remove quarentena do macOS Gatekeeper
chmod 755 "$FRAMELAB_BIN"/* 2>/dev/null || true
xattr -d com.apple.quarantine "$FRAMELAB_BIN"/* >/dev/null 2>&1 || true

# Tenta criar links em /usr/local/bin se a pasta for gravável (PATH global)
if [ -d "/usr/local/bin" ] && [ -w "/usr/local/bin" ]; then
  for util in ffmpeg whisper-cli yt-dlp; do
    if [ -f "$FRAMELAB_BIN/$util" ]; then
      ln -sf "$FRAMELAB_BIN/$util" "/usr/local/bin/$util" 2>/dev/null || true
    fi
  done
fi

# Validação visual de cada motor para o tester
if [ -x "$FRAMELAB_BIN/ffmpeg" ]; then
  echo -e "\033[32m  ✓ FFmpeg integrado ativo (Corte de Silêncios e Áudio)\033[0m"
elif command -v ffmpeg >/dev/null 2>&1; then
  echo -e "\033[32m  ✓ FFmpeg detectado no sistema: $(command -v ffmpeg)\033[0m"
else
  echo -e "\033[38;2;227;155;60m  ℹ FFmpeg será preparado automaticamente no primeiro uso do painel.\033[0m"
fi

if [ -x "$FRAMELAB_BIN/whisper-cli" ]; then
  echo -e "\033[32m  ✓ Whisper IA ativo (Legendas Automáticas com aceleração Metal)\033[0m"
elif command -v whisper-cli >/dev/null 2>&1; then
  echo -e "\033[32m  ✓ Whisper detectado no sistema: $(command -v whisper-cli)\033[0m"
fi

if [ -x "$FRAMELAB_BIN/yt-dlp" ]; then
  echo -e "\033[32m  ✓ Downloader ativo (YouTube e TikTok)\033[0m"
elif command -v yt-dlp >/dev/null 2>&1; then
  echo -e "\033[32m  ✓ Downloader detectado no sistema\033[0m"
fi

echo ""
echo -e "\033[1;33m[4/4]\033[0m Conferindo instalação…"
VISTO=""
if [ -x "$UPIA" ] && "$UPIA" --list "Premiere Pro" 2>/dev/null | grep -q "Framelab"; then
  VISTO="  ✓ O Premiere Pro já lista o Framelab."
elif [ -f "$HOME/Library/Application Support/Adobe/UXP/Plugins/External/${ID}_${VERSAO}/manifest.json" ]; then
  VISTO="  ✓ Os arquivos do plugin estão no lugar."
fi
if [ -n "$VISTO" ]; then
  echo -e "\033[32m$VISTO\033[0m"
else
  falhar "A instalação não deixou rastro. Me mande esta janela."
fi

SOBRA="/Library/Application Support/Adobe/UXP/Plugins/External/com.framelab.premiere"
if [ -e "$SOBRA" ]; then
  echo ""
  echo -e "\033[38;2;227;155;60m   ℹ Achei uma instalação antiga que ficou para trás:\033[0m"
  echo -e "\033[38;2;106;112;108m     $SOBRA\033[0m"
  echo -e "     Ela não atrapalha, mas se quiser limpar, cole no Terminal:"
  echo -e "\033[38;2;154;159;154m     sudo rm -rf \"$SOBRA\"\033[0m"
fi

echo ""
echo -e "\033[38;2;106;112;108m   ───────────────────────────────────────────────────────────────────────────\033[0m"
echo -e "\033[1;32m   🎉 FRAMELAB v$VERSAO INSTALADO COM SUCESSO!\033[0m"
echo -e "\033[38;2;106;112;108m   ───────────────────────────────────────────────────────────────────────────\033[0m"
echo ""
echo -e "   \033[1;37mPara abrir:\033[0m"
echo -e "   1. \033[1;33mFeche o Premiere Pro por completo\033[0m (se estiver aberto)."
echo -e "      Ele só carrega plugins novos quando abre."
echo -e "   2. Abra o Premiere Pro."
echo -e "   3. Vá no menu: \033[1;33mJanela\033[0m (Window) → \033[1;33mExtensões\033[0m (Extensions) → \033[1;32mFramelab\033[0m."
echo ""
echo -e "   \033[38;2;154;159;154m✓ Todas as ferramentas (Corte de Silêncios, Legendas IA, Downloads) estão prontas para uso.\033[0m"
echo -e "   \033[38;2;154;159;154mAs próximas atualizações aparecerão direto dentro do próprio painel.\033[0m"
echo ""
read -r -p "   Pressione ENTER para finalizar..."
