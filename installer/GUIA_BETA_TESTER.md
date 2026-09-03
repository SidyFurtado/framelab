# 🎬 Guia de Instalação e Testes — Framelab (Beta macOS)

Bem-vindo ao programa de Beta Testing do **Framelab**, o painel de ferramentas de automação para o Adobe Premiere Pro.

---

## ⚡ Instalação em 2 Cliques (Tudo Incluso)

### Método Recomendado (Instalação Completa):
1. Dê **dois cliques** no arquivo `Instalar_Framelab.command`.
2. O instalador registrará o plugin no Premiere Pro e configurará automaticamente todos os motores de alta performance (**FFmpeg**, **Whisper IA** e **Downloader**).
3. Pressione Enter ao final e pronto! Nenhum comando ou configuração técnica necessária.

### Outras Opções:
- **Framelab.pkg**: Instalador padrão Apple (copia o plugin para os usuários do sistema).
- **Framelab.ccx**: Pacote oficial Adobe Creative Cloud (2 cliques para instalar pelo app da Adobe).

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

**Edição**
- **Corte de Silêncios**: detecta as pausas pela onda do áudio, corta e encosta os trechos com fala. Já vem com o **FFmpeg integrado** (sem precisar de Homebrew).
- **Legendas Automáticas**: transcrição de altíssima precisão com o motor Whisper IA integrado e aceleração gráfica Apple Metal.
- **Zoom In / Out**: punch-in animado nos clipes selecionados com efeito Transform.
- **Curvas de velocidade**: aplica easing entre keyframes existentes.

**Mídia**
- **Baixar Vídeos**: baixa do YouTube e do TikTok (sempre sem marca d'água), podendo importar direto para a linha do tempo. Downloader integrado.

**Projeto**
- **Organizar Pastas**: separa por tipo os arquivos e sequências soltos na raiz. Suas pastas e as de outros plugins não são tocadas.

### Ainda não nesta versão
- **AI Sound Design**: sugestão e sincronia de efeitos sonoros por IA. Está no plano, mas **não vem nesta build** — se você não achar essa ferramenta no painel, é isso mesmo.

---

## 💬 Feedback & Suporte

Se encontrar qualquer comportamento inesperado ou tiver sugestões:
- Envie mensagem direta para o desenvolvedor ou reporte no GitHub: [github.com/SidyFurtado/framelab/issues](https://github.com/SidyFurtado/framelab/issues).
