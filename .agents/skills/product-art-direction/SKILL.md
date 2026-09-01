---
name: product-art-direction
description: Visual identity and design principles for the multi-tool Premiere Pro platform. Enforces consistent styling, UX patterns, and separation between Product Shell and individual Tools.
---

# Product Art Direction & Platform Design Rules

Use this skill whenever designing, reviewing, or styling UI elements, layouts, or components for the Premiere Pro plugin platform.

## 1. Regras Fundamentais de Arquitetura Visual

> [!IMPORTANT]
> **Regra 1**: Nunca derive a identidade global do produto da primeira ferramenta implementada (AI Sound Design).
> **Regra 2**: Antes de desenhar uma interface, determine se ela pertence ao **Product Shell** ou a uma **Tool específica**.

## 2. Visão de Design da Plataforma
- **Conceito**: Toolbox profissional e de precisão integrada ao Adobe Premiere Pro.
- **Modelo de UX**: **Tool Launcher + Active Tool Workspace**.
- **Filosofia de Interação**: *"Achar ferramenta → Executar tarefa → Voltar para a edição"*. Baixo atrito, alta velocidade e zero poluição visual.

## 3. Separação de Camadas (Shell vs Tool)

### A. Product Shell (Casca Permanente)
- **Componentes**: Cabeçalho global, seletor/abas de categorias (Edição, Áudio, Legendas, Projeto, Mídia), barra de busca de ferramentas, lista de recentes/favoritos, botão de configurações gerais.
- **Estética**: Consistente, sóbria, elegante e perfeitamente integrada aos tons escuros do Premiere Pro.

### B. Tool Workspace (Espaço da Ferramenta Ativa)
- **Componentes**: Painel de controles da ferramenta selecionada, campos de parâmetros, botões de ação específicos (ex: "Processar", "Aplicar"), feedback de progresso e visualizadores de resultado.
- **Natureza das Ferramentas**:
  - *Ferramentas Determinísticas*: Controles instantâneos e diretos.
  - *Ferramentas com IA*: Indicadores claros de estado/progresso e revisão antes de aplicar na timeline.

## 4. Integração com o Premiere Pro
- **Tema Host**: Respeitar as cores do tema do Premiere Pro (dark neutral, borders sutis, botões com contraste AA 4.5:1).
- **Consistência**: O usuário deve reconhecer o mesmo produto profissional ao alternar entre ferramentas de categorias completamente distintas.
- **Documentação de Apoio**: Consulte [docs/DESIGN_DIRECTION.md](file:///Users/sidyziin/Library/CloudStorage/GoogleDrive-sidycontato.f@gmail.com/Meu%20Drive/07_APPS%20E%20DEV/08_EDIT_PLUGIN/docs/DESIGN_DIRECTION.md) para diretrizes completas de UX.
