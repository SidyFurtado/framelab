# Technical Baseline & Research Findings

Este documento define a base técnica da plataforma do plugin e as pesquisas específicas para a primeira ferramenta (`Tool: AI Sound Design`).

---

# PARTE I — BASE DA PLATAFORMA (PRODUCT SHELL)

## 1. Adobe Premiere Pro UXP Host & Ambiente
- **Plataforma**: UXP (Unified Extensibility Platform) para Premiere Pro.
- **Versão Mínima Recomendada**: **Adobe Premiere Pro v24.2+** (para estabilidade básica de DOM) e preferencialmente **v25.0+ / v25.6+** onde as APIs de `SequenceEditor`, `EncoderManager` e transações foram consolidadas.
- **Manifest Version**: `5` (obrigatório para UXP moderno).
- **Módulo Host**: `const app = require('premierepro');`
- **File System & Network Permissions**:
  ```json
  "requiredPermissions": {
    "localFileSystem": "fullAccess",
    "network": {
      "domains": "all"
    }
  }
  ```

## 2. Arquitetura do Product Shell & Tool Registry
- **Desacoplamento**: O `ProductShell` gerencia o ciclo de vida do painel, navegação, catálogo de ferramentas e comunicação centralizada com o host Premiere (`PremiereHostBridge`).
- **Padrão de Tool Registry**: Novas ferramentas são registradas como módulos independentes sem modificar o Shell:
  ```typescript
  interface PluginTool {
    id: string;
    title: string;
    category: 'edit' | 'audio' | 'captions' | 'project' | 'media';
    icon: string;
    description: string;
    requiresAI: boolean;
    renderWorkspace(container: HTMLElement): void;
    destroyWorkspace?(): void;
  }
  ```
- **Pure JS UXP**: 100% suficiente para a casca e ferramentas. UXP Híbrido com C++ é considerado overengineering para a plataforma nesta fase.

---

# PARTE II — ESPECIFICAÇÕES DA PRIMEIRA FERRAMENTA (`Tool: AI Sound Design`)

## 3. Integração com Timeline & Áudio no Premiere
- **Acesso à Sequência**:
  ```javascript
  const project = await app.Project.getActiveProject();
  const sequence = await project.getActiveSequence();
  ```
- **SequenceEditor & Transações**:
  - Manipulações na timeline utilizam `SequenceEditor` e ações atômicas executadas via `project.executeTransaction()` com suporte total a Undo.
- **Controle de Faixas & Importação**:
  - `sequence.getAudioTrackCount()` e `sequence.getAudioTrack(trackIndex)`.
  - `project.importFiles(filePaths, suppressUI, targetBin, asNumberedStills)` para organizar SFX em bin dedicada.

## 4. Provedores de SFX & Avaliação Artlist
- **Artlist Enterprise API** (`developer.artlist.io`): Suportado oficialmente para parceiros corporativos (OAuth 2.0 Cognito). Requer contrato B2B (`enterprise-api-support@artlist.io`).
- **Artlist MCP / Web Scraping**: Incompatíveis ou expressamente proibidos pelo ToS para automação de contas pessoais.
- **Padrão `AudioProvider` para a Tool**:
  - `LocalFolderAudioProvider`: Banco local curado de SFX para desenvolvimento e testes ágeis no MVP.
  - `OpenApiAudioProvider`: Fallback para APIs públicas (Freesound.org).
  - `ArtlistEnterpriseAudioProvider`: Implementação sob contrato comercial futuro.

## 5. Inteligência Artificial — Arquitetura Provider-Agnostic (BYOAI)
O produto adota uma estratégia **Bring Your Own AI (BYOAI)**: o usuário conecta seu provedor preferido via API key.

### 5.1 Camada de Abstração `AIProviderLayer`
Tools declaram capacidades necessárias (ex: `video-understanding`, `structured-output`). A camada `AIProviderLayer` roteia para o adapter conectado pelo usuário:
- `GeminiAdapter` → Google Gemini API
- `ClaudeAdapter` → Anthropic Claude API
- `OpenAIAdapter` → OpenAI API

### 5.2 Capacidades por Provider (Estado Atual — Ago/2026)
| Capacidade | Gemini | Claude (Sonnet/Opus) | OpenAI (GPT-4o / GPT-5.6) |
| :--- | :--- | :--- | :--- |
| **Ingestão Nativa de Vídeo** | ✅ (File API, MP4/MOV com áudio) | ❌ (Somente imagens estáticas) | ❌ (Requer extração manual de frames) |
| **Áudio Nativo** | ✅ | ❌ | Via Whisper separado |
| **Structured Output (JSON)** | ✅ (`response_schema`) | ✅ (Tool Calling) | ✅ (`json_schema`) |
| **Long Context** | 1M-2M tokens | 200k tokens | 128k tokens |
| **Image Understanding** | ✅ | ✅ | ✅ |
| **Tool Calling** | ✅ | ✅ | ✅ |

### 5.3 Autenticação — Consumer Subscription ≠ API Access
> **Regra Crítica**: Assinatura consumer (Claude Pro, ChatGPT Plus, Google AI Pro) **NÃO** é equivalente a acesso via API para terceiros. Cada provider exige conta de API e billing separados.

| Provider | Consumer Product | API Product | Entitlement Cruzado? |
| :--- | :--- | :--- | :--- |
| **Anthropic** | Claude Pro/Max ($20/mês) | API com API key (`sk-ant-...`) via Console | ❌ OAuth restrito a first-party; API key obrigatória para terceiros |
| **OpenAI** | ChatGPT Plus ($20/mês) | API com API key via Platform Dashboard | ❌ Sem OAuth para terceiros; BYOK (API key do usuário) |
| **Google** | Google AI Pro/Ultra | API key via AI Studio / Vertex AI | ❌ Créditos incluídos na subscription, mas API key separada obrigatória |

### 5.4 Candidato Recomendado para `Tool: AI Sound Design`
Gemini é o candidato recomendado inicial para a `Tool: AI Sound Design` por ser o único com ingestão nativa de vídeo+áudio. Porém a implementação deve usar o adapter abstrato (`AIProviderLayer`), permitindo troca futura caso outros providers adicionem suporte a vídeo.

## 6. Teoria & Princípios de Sound Design
- **Taxonomia de SFX**: Ambience/Beds, Transitions/Whooshes, Impacts/Hits, UI/Digital, Motion Graphics, Camera Dynamics, Foley.
- **Regras Acústicas**: Layering (Sub + Mid + Transient), alinhamento de transiente vs pre-roll, hierarquia de loudness (diálogo supremo, SFX entre -12 e -34 dB), controle de densidade (anti-clutter).
- **Bibliografia**: David Sonnenschein (*Sound Design*), Ric Viers (*The Sound Effects Bible*), Michel Chion (*Audio-Vision*), Andy Farnell (*Designing Sound*).
