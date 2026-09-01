# Framelab — Adobe Premiere Pro UXP Extension

> Suíte multiferramentas de precisão e automação com inteligência artificial para o Adobe Premiere Pro.

![Framelab Beta](https://img.shields.io/badge/Release-Beta%20v0.1.0-orange?style=flat-square)
![Premiere Pro](https://img.shields.io/badge/Premiere%20Pro-v24.2%2B%20%7C%20v25%2B-blue?style=flat-square)
![Platform](https://img.shields.io/badge/Platform-macOS%20(Apple%20Silicon%20%26%20Intel)-lightgrey?style=flat-square)

---

## ⚡ Instalação Rápida para Beta Testers

1. Baixe o instalador mais recente em [Releases](https://github.com/SidyFurtado/framelab/releases/latest) ou através do [Beta Hub](https://sidyfurtado.github.io/framelab/).
2. Descompacte o arquivo `Framelab-macOS.zip`.
3. Dê dois cliques em `Instalar_Framelab.command`.
4. Abra o Adobe Premiere Pro e acesse **Janela (Window)** > **Extensões (Extensions)** > **Framelab**.

---

## 🔄 Sistema de Atualização Automática (In-Plugin)

O plugin conta com auto-update integrado via GitHub:
- Ao abrir o painel no Premiere Pro, ele consulta o manifesto `version.json`.
- Se uma nova versão for detectada, o botão **✨ Atualizar (vX.X.X)** aparece no topo.
- Ao clicar em **Atualizar Agora**, o plugin faz o download *in-place* e solicita apenas o recarregamento do painel (`window.location.reload()`), sem precisar fechar o Premiere.

---

## 🛠 Ferramentas Incluídas

- **Silence Cut**: Detecção e remoção inteligente de silêncio na timeline com waveform visual e controle fino de transientes.
- **AI Sound Design**: Geração e inserção atômica de efeitos sonoros (SFX) em faixas dedicadas baseadas em IA multimodal.
- **Curvas de Animação**: Interpolação e curvas de aceleração Bezier suaves aplicáveis em 1 clique.
- **Dynamic Zoom**: Efeitos dinâmicos de escala e enquadramento para cortes de diálogo e podcasts.

---

## 💻 Desenvolvimento & Build

```bash
# Instalar dependências
npm install

# Checagem de tipos
npm run typecheck

# Compilação do bundle
npm run build

# Empacotar instalador Mac e pacote .CCX
npm run package
```

---

## 📄 Licença

Desenvolvido por **Sidy Furtado**. Todos os direitos reservados.
