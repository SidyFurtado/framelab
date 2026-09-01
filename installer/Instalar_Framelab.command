#!/usr/bin/env bash
# ============================================================
#  FRAMELAB — INSTALADOR AUTOMÁTICO PARA MAC (BETA)
# ============================================================

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
echo -e "\033[38;2;154;159;154m   Versão Beta 0.1.0 • Desenvolvido por Sidy Furtado\033[0m"
echo -e "\033[38;2;106;112;108m   ───────────────────────────────────────────────────────────────────────────\033[0m"
echo ""

# Localiza a pasta onde o script está sendo executado
SOURCE_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Encontra a pasta com os arquivos do plugin (pode ser dist/ ou a própria pasta se descompactado)
PLUGIN_FILES=""
if [ -f "$SOURCE_DIR/manifest.json" ] && [ -f "$SOURCE_DIR/index.js" ]; then
    PLUGIN_FILES="$SOURCE_DIR"
elif [ -d "$SOURCE_DIR/dist" ] && [ -f "$SOURCE_DIR/dist/manifest.json" ]; then
    PLUGIN_FILES="$SOURCE_DIR/dist"
elif [ -d "$SOURCE_DIR/../dist" ] && [ -f "$SOURCE_DIR/../dist/manifest.json" ]; then
    PLUGIN_FILES="$SOURCE_DIR/../dist"
elif [ -d "$SOURCE_DIR/Framelab" ] && [ -f "$SOURCE_DIR/Framelab/manifest.json" ]; then
    PLUGIN_FILES="$SOURCE_DIR/Framelab"
fi

if [ -z "$PLUGIN_FILES" ]; then
    echo -e "\033[1;31m❌ Erro: Arquivos do plugin não foram encontrados na pasta de instalação.\033[0m"
    echo -e "   Certifique-se de que descompactou o arquivo ZIP por completo antes de executar."
    echo ""
    read -p "Pressione ENTER para fechar..."
    exit 1
fi

echo -e "\033[1;33m[1/3]\033[0m Verificando ambiente Adobe no macOS..."

# Pastas de destino UXP no macOS
UXP_TARGET_1="$HOME/Library/Application Support/Adobe/UXP/Plugins/External/com.framelab.premiere"
UXP_TARGET_2="$HOME/Library/Application Support/Adobe/UXP/PluginsStorage/com.framelab.premiere"

# Cria as pastas de destino se não existirem
mkdir -p "$UXP_TARGET_1"
mkdir -p "$UXP_TARGET_2"

echo -e "\033[32m  ✓ Diretórios UXP preparados com sucesso.\033[0m"
echo ""

echo -e "\033[1;33m[2/3]\033[0m Instalando arquivos do Framelab..."

# Copia os arquivos do bundle
cp -f "$PLUGIN_FILES/manifest.json" "$UXP_TARGET_1/" 2>/dev/null || true
cp -f "$PLUGIN_FILES/index.html" "$UXP_TARGET_1/" 2>/dev/null || true
cp -f "$PLUGIN_FILES/index.js" "$UXP_TARGET_1/" 2>/dev/null || true
cp -f "$PLUGIN_FILES/index.css" "$UXP_TARGET_1/" 2>/dev/null || true

# Copia também para PluginsStorage para máxima compatibilidade
cp -Rf "$PLUGIN_FILES/"* "$UXP_TARGET_2/" 2>/dev/null || true

# Garante permissões adequadas
chmod -R 755 "$UXP_TARGET_1" 2>/dev/null || true
chmod -R 755 "$UXP_TARGET_2" 2>/dev/null || true

echo -e "\033[32m  ✓ Arquivos instalados em:\033[0m"
echo -e "    \033[38;2;154;159;154m$UXP_TARGET_1\033[0m"
echo ""

echo -e "\033[1;33m[3/3]\033[0m Verificando Adobe Premiere Pro instalado..."

PREMIERE_FOUND=false
for app_path in "/Applications/Adobe Premiere Pro 2025" "/Applications/Adobe Premiere Pro 2024" "/Applications/Adobe Premiere Pro 2026" "/Applications/Adobe Premiere Pro Beta"; do
    if [ -d "$app_path" ]; then
        echo -e "\033[32m  ✓ Encontrado: $(basename "$app_path")\033[0m"
        PREMIERE_FOUND=true
    fi
done

if [ "$PREMIERE_FOUND" = false ]; then
    echo -e "\033[38;2;227;155;60m  ℹ Premiere Pro não detectado no caminho padrão, mas os arquivos foram instalados.\033[0m"
fi

echo ""
echo -e "\033[38;2;106;112;108m   ───────────────────────────────────────────────────────────────────────────\033[0m"
echo -e "\033[1;32m   🎉 INSTALAÇÃO CONCLUÍDA COM SUCESSO!\033[0m"
echo -e "\033[38;2;106;112;108m   ───────────────────────────────────────────────────────────────────────────\033[0m"
echo ""
echo -e "   \033[1;37mComo abrir o plugin no Premiere Pro:\033[0m"
echo -e "   1. Abra o \033[1;33mAdobe Premiere Pro\033[0m."
echo -e "   2. No menu superior, clique em \033[1;33mJanela\033[0m (Window) > \033[1;33mExtensões\033[0m (Extensions)."
echo -e "   3. Selecione \033[1;32mFramelab\033[0m."
echo ""
echo -e "   \033[38;2;154;159;154mDica: Atualizações futuras aparecerão automaticamente dentro do painel!\033[0m"
echo ""
read -p "Pressione ENTER para finalizar..."
