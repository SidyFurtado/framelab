#!/usr/bin/env bash
# ============================================================
#  FRAMELAB — DESINSTALADOR (MAC)
# ============================================================
#
#  Tira o plugin pelas duas rotas por onde ele pode ter entrado: o
#  registro da Adobe (UPIA) e a pasta que o Premiere varre.
#
#  As pastas terminam em `_versão` — `com.framelab.premiere_0.3.1` —
#  então apagar o nome cru não removia nada. Era por isso que o
#  desinstalador antigo dizia "removido com sucesso" e não removia.
# ============================================================

set -u
clear
echo ""
echo -e "\033[1;33m   === DESINSTALADOR DO FRAMELAB ===\033[0m"
echo ""

UPIA="/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent"
REMOVIDO=0

if [ -x "$UPIA" ]; then
  echo "   Pedindo ao instalador da Adobe para remover…"
  if "$UPIA" --remove "Framelab" 2>&1 | grep -q "Removal Successful"; then
    echo -e "\033[32m   ✓ Removido do registro da Adobe.\033[0m"
    REMOVIDO=1
  fi
fi

echo "   Limpando as pastas do plugin…"
EXTERNAL="$HOME/Library/Application Support/Adobe/UXP/Plugins/External"
for id in com.framelab.premiere com.edittoolbox.premiere; do
  for alvo in "$EXTERNAL/$id" "$EXTERNAL/${id}_"*; do
    if [ -e "$alvo" ]; then
      rm -rf "$alvo" && REMOVIDO=1
      echo -e "\033[38;2;154;159;154m     $(basename "$alvo")\033[0m"
    fi
  done
done

echo ""
if [ "$REMOVIDO" -eq 1 ]; then
  echo -e "\033[32m   ✓ Framelab removido. Reinicie o Premiere Pro.\033[0m"
else
  echo -e "\033[38;2;227;155;60m   ℹ Não havia nada instalado por aqui.\033[0m"
fi
echo ""
echo -e "\033[38;2;154;159;154m   Os ajustes e o glossário do projeto ficam guardados, caso você\033[0m"
echo -e "\033[38;2;154;159;154m   reinstale depois. Para apagá-los também, remova a pasta:\033[0m"
echo -e "\033[38;2;106;112;108m   ~/Library/Application Support/Adobe/UXP/PluginsStorage/PPRO\033[0m"
echo ""
read -r -p "   Pressione ENTER para fechar..."
