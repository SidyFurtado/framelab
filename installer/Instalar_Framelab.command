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

echo -e "\033[1;33m[1/3]\033[0m Framelab v$VERSAO — procurando o instalador da Adobe…"

UPIA="/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent"
CCX=""
for c in "$DIR/Framelab.ccx" "$DIR/../Framelab.ccx"; do
  [ -f "$c" ] && CCX="$c" && break
done

INSTALADO=""
if [ -x "$UPIA" ] && [ -n "$CCX" ]; then
  echo -e "\033[32m  ✓ Encontrado. Instalando pelo caminho oficial da Adobe.\033[0m"
  echo ""
  echo -e "\033[1;33m[2/3]\033[0m Instalando…"
  # A versão anterior sai antes: instalar por cima deixa duas pastas e
  # o Premiere lista o plugin duas vezes.
  "$UPIA" --remove "Framelab" >/dev/null 2>&1 || true
  if "$UPIA" --install "$CCX" 2>&1 | grep -q "Installation Successful"; then
    INSTALADO="upia"
    echo -e "\033[32m  ✓ Instalado e registrado pelo Adobe UPIA.\033[0m"
  else
    echo -e "\033[38;2;227;155;60m  ℹ O instalador da Adobe recusou. Seguindo pela cópia direta.\033[0m"
  fi
else
  echo -e "\033[38;2;227;155;60m  ℹ Não encontrado nesta máquina. Seguindo pela cópia direta.\033[0m"
  echo ""
  echo -e "\033[1;33m[2/3]\033[0m Instalando…"
fi

# ── rota 2: a pasta que o Premiere varre sozinho ──────────────────
if [ -z "$INSTALADO" ]; then
  DESTINO="$HOME/Library/Application Support/Adobe/UXP/Plugins/External/${ID}_${VERSAO}"
  # Versões antigas do MESMO plugin saem: cada uma é uma pasta, e o
  # Premiere carregaria as duas.
  ANTIGAS="$HOME/Library/Application Support/Adobe/UXP/Plugins/External"
  if [ -d "$ANTIGAS" ]; then
    for velha in "$ANTIGAS/${ID}_"*; do
      [ -e "$velha" ] && [ "$velha" != "$DESTINO" ] && rm -rf "$velha"
    done
  fi
  mkdir -p "$DESTINO" || falhar "Não consegui criar a pasta de destino."
  for f in manifest.json index.html index.js index.css; do
    cp -f "$ARQUIVOS/$f" "$DESTINO/" || falhar "Não consegui copiar $f."
  done
  chmod -R 755 "$DESTINO" 2>/dev/null || true
  INSTALADO="pasta"
  echo -e "\033[32m  ✓ Copiado para:\033[0m"
  echo -e "    \033[38;2;154;159;154m$DESTINO\033[0m"
fi

echo ""
echo -e "\033[1;33m[3/3]\033[0m Conferindo…"
VISTO=""
if [ -x "$UPIA" ] && "$UPIA" --list "Premiere Pro" 2>/dev/null | grep -q "Framelab"; then
  VISTO="  ✓ O Premiere já lista o Framelab."
elif [ -f "$HOME/Library/Application Support/Adobe/UXP/Plugins/External/${ID}_${VERSAO}/manifest.json" ]; then
  VISTO="  ✓ Os arquivos estão no lugar."
fi
if [ -n "$VISTO" ]; then
  echo -e "\033[32m$VISTO\033[0m"
else
  falhar "A instalação não deixou rastro. Me mande esta janela."
fi

echo ""
echo -e "\033[38;2;106;112;108m   ───────────────────────────────────────────────────────────────────────────\033[0m"
echo -e "\033[1;32m   🎉 FRAMELAB v$VERSAO INSTALADO\033[0m"
echo -e "\033[38;2;106;112;108m   ───────────────────────────────────────────────────────────────────────────\033[0m"
echo ""
echo -e "   \033[1;37mPara abrir:\033[0m"
echo -e "   1. \033[1;33mFeche o Premiere Pro por completo\033[0m (se estiver aberto)."
echo -e "      Ele só procura plugins novos quando abre."
echo -e "   2. Abra o Premiere."
echo -e "   3. Menu \033[1;33mJanela\033[0m (Window) → \033[1;33mExtensões\033[0m (Extensions) → \033[1;32mFramelab\033[0m."
echo ""
echo -e "   \033[38;2;154;159;154mAs próximas atualizações aparecem dentro do próprio painel.\033[0m"
echo ""
read -r -p "   Pressione ENTER para finalizar..."
