# 🎬 Guia de Instalação e Testes — Framelab (Beta macOS)

Bem-vindo ao programa de Beta Testing do **Framelab**, o painel de ferramentas de automação para o Adobe Premiere Pro.

---

## ⚡ Instalação Rápida (1 Minuto)

### Opção 1: Instalador Automático (Recomendado)
1. Descompacte o arquivo `Framelab-macOS.zip` que você baixou.
2. Dê **dois cliques** no arquivo `Instalar_Framelab.command`.
3. Uma janela do Terminal será aberta confirmando a instalação.
4. Pressione `ENTER` e pronto!

### Opção 2: Pacote `.ccx` (Creative Cloud)
1. Dê dois cliques no arquivo `Framelab.ccx`.
2. O aplicativo Adobe Creative Cloud abrirá automaticamente solicitando a instalação.
3. Clique em **Instalar** (Install locally).

---

## 🚀 Como Abrir o Plugin no Premiere Pro

1. Abra o **Adobe Premiere Pro** (v25.0 ou superior).
2. No menu superior da barra de menus do macOS, acesse:
   **Janela** (*Window*) → **Extensões** (*Extensions*) → **Framelab**.
3. O painel se abrirá! Você pode acoplá-lo ao lado da sua linha de tempo (timeline), nas abas de efeitos ou utilizá-lo flutuante.

---

## 🔄 Atualizações Automáticas (Sem Reinstalar!)

Sempre que uma nova funcionalidade ou correção for lançada:
1. Uma notificação com botão **✨ Atualizar (vX.X.X)** aparecerá automaticamente no topo do painel do Framelab.
2. Basta clicar no botão, conferir o changelog e clicar em **Atualizar Agora**.
3. O plugin atualizará sozinho e solicitará apenas um clique em **Recarregar Painel**, sem você precisar fechar o Premiere Pro!

---

## 🛠 Ferramentas Disponíveis na Versão Beta

São cinco, em três categorias — as mesmas que aparecem na lista do painel.

**Edição**
- **Zoom In / Out**: punch-in animado nos clipes selecionados. Os keyframes entram num efeito Transform novo, sem tocar no Motion original.
- **Corte de Silêncios**: detecta as pausas pela onda do áudio, corta e encosta os trechos com fala. Precisa do ffmpeg instalado.
- **Curvas de velocidade**: assa easing entre keyframes que já existem, por trecho.

**Mídia**
- **Baixar Vídeos**: baixa do YouTube e do TikTok, escolhendo a qualidade. O TikTok vem sempre sem marca d'água, e o arquivo pode entrar direto no projeto aberto.

**Projeto**
- **Organizar Pastas**: separa por tipo os arquivos e sequências soltos na raiz. Suas pastas e as de outros plugins não são tocadas.

### Ainda não nesta versão
- **AI Sound Design**: sugestão e sincronia de efeitos sonoros por IA. Está no plano, mas **não vem nesta build** — se você não achar essa ferramenta no painel, é isso mesmo.

---

## 💬 Feedback & Suporte

Se encontrar qualquer comportamento inesperado ou tiver sugestões:
- Envie mensagem direta para o desenvolvedor ou reporte no GitHub: [github.com/SidyFurtado/framelab/issues](https://github.com/SidyFurtado/framelab/issues).
