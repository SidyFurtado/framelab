# Tools & Skills Registry

Este documento registra as ferramentas e skills homologadas para o workspace, seu status de ativação e políticas de uso.

---

## Tabela de Ferramentas e Skills

| Tool / Skill | Status | Purpose | Source | Activation |
| :--- | :--- | :--- | :--- | :--- |
| **product-art-direction** | Installed (Local) | Identidade global da plataforma (Shell vs Tool) | Workspace (`.agents/skills/product-art-direction`) | On demand |
| **premiere-uxp** | Installed (Local) | Manipulação DOM Premiere UXP & Timeline | Workspace (`.agents/skills/premiere-uxp`) | On demand |
| **ai-video-analysis** | Installed (Local) | Ingestão Gemini & Análise Multimodal (Tool Sound Design) | Workspace (`.agents/skills/ai-video-analysis`) | On demand |
| **sound-design-intelligence** | Installed (Local) | Taxonomia SFX & Regras Acústicas (Tool Sound Design) | Workspace (`.agents/skills/sound-design-intelligence`) | On demand |
| **audio-asset-integration** | Installed (Local) | Adapter para Catálogos de Áudio (Tool Sound Design) | Workspace (`.agents/skills/audio-asset-integration`) | On demand |
| **ui-ux-pro-max** | Installed | Design intelligence, tipografia, cores, UX | `nextlevelbuilder/ui-ux-pro-max-skill` (v2.15.0) | On demand |
| **frontend-design** | Installed | Direção visual deliberada e anti-genérica | `anthropics/skills` (Oficial Anthropic) | On demand |
| **context7** | Installed | Consulta pontual a docs atualizadas via CLI | `upstash/context7` (`ctx7` CLI) | On demand |
| **Serena** | Future Approved | Navegação semântica via LSP e símbolos | `oraios/serena` | Fase de codificação |
| **UI Skills (ibelick)** | Future Approved | Acessibilidade e otimização de movimento | `ibelick/ui-skills` | Quando stack UI estiver definida |
| **Figma MCP** | Future Approved | Handoff de design e tokens visuais | Adobe/Figma MCP oficial | Quando arquivo Figma existir |

---

## Ferramentas Avaliadas e Rejeitadas (Nesta Fase)

- **Mega bundles / Coleções massivas** (ex: *1000+ agent skills*, *awesome-skills* completo): Rejeitadas para evitar conflitos de roteamento e inchaço de contexto.
- **Skills duplicadas de design** (Taste, Awwwards clones): Rejeitadas pois `ui-ux-pro-max` + `frontend-design` cobrem todo o espectro necessário.
- **MCPs Permanentes Desnecessários** (Sequential Thinking, GitHub MCP, Supabase, DBs, Mobbin, Locofy, Lovable): Rejeitados para economizar tokens e manter superfície de ferramentas limpa.
