# Core Guidelines & Project Rules

## 1. Visão da Plataforma & Arquitetura
- O produto é uma **plataforma multiferramentas (toolbox)** para acelerar edição no Adobe Premiere Pro.
- **Tool ≠ Product**: `AI Sound Design` é apenas a primeira ferramenta planejada. A arquitetura separa estritamente o **Product Shell** (infraestrutura compartilhada, navegação, catálogo) dos **Tools / Modules** (funcionalidades independentes).
- Novas ferramentas (determinísticas ou IA) devem ser adicionáveis no `ToolRegistry` sem impactar o Shell ou outras ferramentas.
- **Bring Your Own AI (BYOAI)**: O produto é provider-agnostic. O usuário conecta seu próprio provedor de IA (Claude, OpenAI, Gemini). Tools declaram capacidades necessárias (ex: `video-understanding`, `structured-output`); não dependem diretamente de um fornecedor. Consumer subscription ≠ API access — validar individualmente por provider.

## 2. Padrões de Código & UXP-First
- **UXP Exclusivo**: Utilize exclusivamente APIs modernas de UXP (Manifest v5). Não use CEP/ExtendScript legado.
- **APIs Oficiais**: Não invente APIs; consulte a documentação oficial da Adobe (`developer.adobe.com/premiere-pro/uxp`).
- **Transações Atômicas**: Modificações de timeline devem usar `SequenceEditor` e `project.executeTransaction()`.

## 3. Diretrizes de Design de Interface
- Nunca derive a identidade visual global do produto da primeira ferramenta implementada.
- Antes de desenhar qualquer UI, determine se ela pertence ao **Product Shell** ou ao **Tool Workspace**.

## 4. Eficiência de Contexto, Tokens & Execução
- **Foco e Escopo**: Uma tarefa fechada por execução. Implemente e valide na mesma rodada quando iniciarmos código.
- **Leitura Cirúrgica**: Leia apenas arquivos diretamente relevantes. Não faça exploração repo-wide sem necessidade.
- **Progressive Disclosure**: Skills, ferramentas e documentações externas são ativadas apenas sob demanda.
- **Critério de Parada**: Atingido o critério de sucesso, pare imediatamente; não adicione melhorias não solicitadas.
- **Resolução Rápida**: Se duas tentativas de correção falharem, pare de acumular contexto e reavalie a abordagem.
