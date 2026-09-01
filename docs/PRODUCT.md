# Product Vision & Platform Architecture

## 1. Visão Geral do Produto
O produto é uma **plataforma multiferramentas (toolbox profissional) para Adobe Premiere Pro**, projetada para acelerar tarefas repetitivas, técnicas e criativas do fluxo de trabalho de edição de vídeo.

Conceitualmente, o produto opera como um ecossistema expansível de utilitários integrados ao Premiere:
- **Catálogo de Ferramentas**: Ferramentas organizadas por categorias (Edição, Áudio, Legendas, Projeto, Mídia, etc.).
- **Independência Modular**: Cada ferramenta resolve um problema específico com sua própria interface, regras e configurações.
- **IA Onde Faz Sentido**: O produto não é exclusivamente uma ferramenta de IA. Ferramentas podem ser puramente determinísticas (automações rápidas de timeline) ou potencializadas por modelos multimodais de IA quando agregarem valor real.
- **Filosofia de UX**: *"Achar ferramenta → Executar tarefa → Voltar para a edição"* com atrito mínimo. O modelo mental é de **Tool Launcher + Active Tool Workspace**.

---

## 2. Arquitetura Conceitual da Plataforma

A arquitetura desacopla estritamente a casca permanente do produto de suas ferramentas individuais:

```mermaid
graph TD
    subgraph Product Shell [Product Shell (Infraestrutura Permanente)]
        Nav[Navegação & Categorias]
        Search[Busca & Descoberta de Tools]
        Prefs[Preferências & Estados Globais]
        Bridge[Premiere Host Bridge (UXP)]
        Services[Shared Services & Providers]
    end

    subgraph Tool Registry [Tool Registry (Catálogo Desacoplado)]
        T1["Tool 1: AI Sound Design (Primeira Tool)"]
        T2["Tool 2: Silence & Filler Remover"]
        T3["Tool 3: Timeline Automations"]
        TN["Tool N: Futuras Ferramentas..."]
    end

    Product Shell --> Tool Registry
```

### 2.1 Product Shell (Casca da Plataforma)
Camada permanente do plugin, responsável por:
- Navegação entre categorias e seleção de ferramentas;
- Mecanismo de busca e atalhos para ferramentas favoritas/recentes;
- Gerenciamento de preferências do usuário e configurações globais;
- Comunicação centralizada e segura com o host Premiere (UXP DOM Bridge);
- Infraestrutura compartilhada (gerenciamento de API keys, notificações, updates, licenciamento).

### 2.2 Tools / Modules (Ferramentas Independentes)
Unidades funcionais desacopladas. Cada ferramenta possui:
- Painel de interface dedicado (Active Tool Workspace);
- Lógica de processamento isolada (determinística ou IA);
- Parâmetros e presets próprios;
- Comandos específicos de execução na timeline.

---

## 3. Primeira Ferramenta Planejada: `Tool: AI Sound Design`

A funcionalidade de **AI Sound Design** é **apenas a primeira ferramenta** a ser construída dentro da plataforma.

### Escopo da Ferramenta
1. **Análise Audiovisual**: Análise de vídeo/áudio e estrutura de cortes da timeline.
2. **Identificação de Oportunidades**: Detecção de movimentos, transições, cortes, textos, gráficos e ambiências.
3. **Seleção de Assets**: Escolha e resolução de SFX (Whooshes, Impacts, Risers, UI, Ambience, Foley).
4. **Inserção Automatizada**: Posicionamento preciso e não-destrutivo na timeline em faixas dedicadas de áudio.

> [!IMPORTANT]
> A ferramenta de AI Sound Design **não define** a identidade visual, a arquitetura do Product Shell, nem os padrões das demais ferramentas da plataforma.

---

## 4. Exemplos Conceituais de Futuras Ferramentas (Território de Expansão)
*(Exemplos ilustrativos de território funcional; não representam roadmap fechado)*

- **Categoria Edição**: Removedor de silêncios, auto zoom dinâmico, suavizador de keyframes, automações de cortes.
- **Categoria Áudio**: AI Sound Design, auto-ducking inteligente, organizador de faixas, nivelador de volume.
- **Categoria Legendas**: Gerador de captions estilizadas, sincronizador de texto, animação de títulos.
- **Categoria Projeto**: Organização automática de bins, renomeação de mídias por metadados, limpeza de projeto.
- **Categoria Mídia**: Importação e download de assets, integração com repositórios externos.
