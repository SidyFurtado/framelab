#!/usr/bin/env bash
# ============================================================
#  FRAMELAB — DESINSTALADOR (MAC)
# ============================================================

clear
echo ""
echo -e "\033[1;33m=== DESINSTALADOR DO FRAMELAB ===\033[0m"
echo ""
echo "Removendo pastas do plugin dos diretórios UXP do Premiere Pro..."

rm -rf "$HOME/Library/Application Support/Adobe/UXP/Plugins/External/com.framelab.premiere" 2>/dev/null || true
rm -rf "$HOME/Library/Application Support/Adobe/UXP/PluginsStorage/com.framelab.premiere" 2>/dev/null || true
rm -rf "$HOME/Library/Application Support/Adobe/UXP/Plugins/External/com.edittoolbox.premiere" 2>/dev/null || true
rm -rf "$HOME/Library/Application Support/Adobe/UXP/PluginsStorage/com.edittoolbox.premiere" 2>/dev/null || true

echo -e "\033[32m✓ Plugin removido com sucesso.\033[0m"
echo ""
read -p "Pressione ENTER para fechar..."
