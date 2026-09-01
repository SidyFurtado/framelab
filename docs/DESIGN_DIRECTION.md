# Platform Design Direction & UX Principles

Este documento estabelece as diretrizes de design de interface e experiência de usuário (UI/UX) para a **plataforma multiferramentas** no Adobe Premiere Pro.

---

## 1. Visão de Design da Plataforma
A identidade visual e a experiência de uso pertencem à **plataforma (Product Shell)**, e não a uma ferramenta individual.

O usuário deve sentir que está operando uma **toolbox de precisão profissional**, integrada de forma elegante e nativa ao Adobe Premiere Pro, mantendo consistência visual mesmo ao alternar entre ferramentas completamente diferentes.

---

## 2. Princípios Fundamentais de UX

### 2.1 Modelo Mental: Tool Launcher + Active Tool Workspace
- **Tool Launcher**: Navegação rápida por categorias, busca instantânea e acesso a ferramentas recentes/favoritas.
- **Active Tool Workspace**: Espaço de trabalho focado na ferramenta selecionada, com controles limpos, objetivos e sem poluição visual.

### 2.2 Foco em Produtividade & Baixo Atrito
- **Fluxo Ágil**: *"Achar ferramenta → Executar tarefa → Voltar para a edição"*.
- **Sem Fricção Desnecessária**: Não transformar o Premiere em outro software inchado. A interface deve ser direta, rápida e responsiva.
- **Diversidade de Ferramentas**:
  - *Ferramentas Determinísticas*: Execução instantânea com parâmetros diretos (ex: automação de cortes, renomeação de bins).
  - *Ferramentas com IA*: Indicadores de progresso claros, visualização prévia e botões de ação objetivos.

---

## 3. Separação de Camadas de Interface (Shell vs Tool)

> [!IMPORTANT]
> **Regra de Ouro 1**: Nunca derive a identidade visual global do produto da primeira ferramenta implementada (Sound Design).
> **Regra de Ouro 2**: Antes de projetar qualquer elemento de UI, determine se ele pertence ao **Product Shell** ou a uma **Tool específica**.

| Elemento de UI | Camada | Responsabilidade |
| :--- | :--- | :--- |
| **Cabeçalho & Logo do Produto** | Product Shell | Identidade unificada da plataforma |
| **Abas de Categoria / Seletor** | Product Shell | Navegação entre Edit, Audio, Captions, Project, Media |
| **Barra de Busca de Ferramentas** | Product Shell | Localização rápida de utilitários |
| **Menu de Configurações Globais** | Product Shell | API Keys, preferências gerais, updates |
| **Notificações / Toasts do Host** | Product Shell | Feedback de sistema padronizado |
| **Painel de Parâmetros da Tool** | Tool Workspace | Controles específicos da ferramenta ativa |
| **Botão de Ação / Execução** | Tool Workspace | Disparo da lógica da ferramenta |
| **Visualizador de Resultados / Preview**| Tool Workspace | Dados e partituras específicas da ferramenta |

---

## 4. Estética & Integração Visual com o Premiere Pro
- **Tema & Cores**: Paleta escura harmoniosa com os tons padrão da Adobe (neutros profundos, bordas sutis, contraste acessível WCAG AA 4.5:1).
- **Tipografia**: Hierarquia clara, fontes de sistema/UI modernas com alta legibilidade em painéis compactos.
- **Micro-interações**: Feedback tátil imediato em botões, estados de hover e transições suaves sem excessos.
