# Specification: Tool — Zoom In / Zoom Out (Foundation MVP)

## 1. Visão Geral & Propósito
A ferramenta **Zoom In / Zoom Out** é a **Foundation Tool** da plataforma.

Seu objetivo exclusivo é validar no mundo real a infraestrutura básica do plugin:
- Product Shell e ciclo de vida de uma Tool isolada;
- Integração e comunicação com Premiere Pro UXP DOM;
- Leitura de seleção de clips na timeline;
- Manipulação de propriedades de efeitos intrínsecos (`Motion > Scale`);
- Inserção precisa de keyframes e timing;
- Execução atômica e suporte nativo a Undo (`project.executeTransaction`);
- Tratamento de múltiplos clips e mensagens de feedback/erro.

---

## 2. User Flow (Fluxo Mínimo)
1. O editor seleciona um ou mais clips de vídeo na timeline do Premiere Pro.
2. No plugin, seleciona a ferramenta **Zoom** (na categoria *Edição*).
3. Na interface da ferramenta, o editor define:
   - **Direção**: `Zoom In` ou `Zoom Out`;
   - **Intensidade**: Ex: `115%` (range seguro padrão: `105%` a `150%`);
   - **Duração da Animação**: Ex: `0.5s`, `1.0s` ou `Clip Inteiro`.
4. O editor clica no botão **Aplicar Zoom**.
5. O plugin valida a seleção, calcula os pontos de tempo (`TickTime`) e aplica os keyframes em `Motion > Scale` em uma única transação atômica.
6. O editor visualiza a alteração na timeline e pode revertê-la com `Ctrl+Z` / `Cmd+Z` (Undo único).

---

## 3. Inputs (Parâmetros da V1)

| Parâmetro | Tipo | Valores / Padrão | Descrição |
| :--- | :--- | :--- | :--- |
| **Direction** | Segmented Control / Radio | `Zoom In` (Padrão) \| `Zoom Out` | Direção do movimento de escala |
| **Scale Target (Intensidade)** | Slider / Number Input | `105%` a `150%` (Padrão: `115%`) | Valor final (Zoom In) ou inicial (Zoom Out) |
| **Duration Mode** | Dropdown / Tabs | `Transição Curta (0.5s)` \| `Transição Média (1.0s)` \| `Clip Inteiro` | Janela temporal onde os keyframes serão posicionados |

---

## 4. Comportamento & Posicionamento de Keyframes

### 4.1 Zoom In
- **Keyframe 1**: Posicionado no início da animação ($t_0$) com valor `Scale = 100.0%` (ou valor estático atual do clip).
- **Keyframe 2**: Posicionado em $t_0 + \text{Duração}$ com valor `Scale = Scale Target` (ex: `115.0%`).
- *(Se Duração = "Clip Inteiro", Keyframe 1 fica no primeiro frame do clip e Keyframe 2 no último frame).*

### 4.2 Zoom Out
- **Keyframe 1**: Posicionado no início da animação ($t_0$) com valor `Scale = Scale Target` (ex: `115.0%`).
- **Keyframe 2**: Posicionado em $t_0 + \text{Duração}$ com valor `Scale = 100.0%`.

### 4.3 Múltiplos Clips Selecionados
- A ferramenta itera sobre todos os clips de vídeo selecionados.
- Aplica a mesma regra de keyframes independentemente em cada clip individual.
- Todas as alterações são agrupadas dentro de **uma única transação** (`project.executeTransaction`), permitindo desfazer tudo de uma vez.

---

## 5. Política para Keyframes Existentes (Existing Keyframes Policy)

> [!IMPORTANT]
> **Política de Segurança para V1: Preservação Estrita (Não-Destrutivo)**
> Se a propriedade `Motion > Scale` do clip já possuir keyframes ativos (`scaleParam.isTimeVarying() === true`), a ferramenta **NÃO sobrescreverá nem apagará** a animação existente.

### Comportamento:
1. O plugin verifica o suporte e o estado do parâmetro:
   - `await scaleParam.areKeyframesSupported()` deve ser `true`.
   - `scaleParam.isTimeVarying()` é consultado.
2. Se `scaleParam.isTimeVarying() === true`, o clip é **ignorado** e registrado na lista de avisos.
3. A Tool exibe feedback claro: *"1 clip ignorado pois já possui keyframes em Scale. Animação existente preservada."*
4. Se múltiplos clips foram selecionados e apenas alguns tinham keyframes, a ferramenta aplica o zoom nos clips livres e notifica quais foram ignorados.

---

## 6. Regras de Seleção & Casos de Borda

| Cenário de Seleção | Comportamento da V1 | Feedback na UI |
| :--- | :--- | :--- |
| **Nenhum clip selecionado** | Bloqueia execução | Mensagem informativa: *"Selecione ao menos um clip de vídeo na timeline."* |
| **1 clip de vídeo válido** | Executa normalmente | Notificação: *"Zoom aplicado com sucesso."* |
| **Múltiplos clips de vídeo** | Processa em lote em 1 transação | Notificação: *"Zoom aplicado em X clips."* |
| **Clips de áudio selecionados** | Filtra e ignora faixas de áudio via `await item.getMediaType()` | Processa apenas os clips de vídeo da seleção; se houver apenas áudio, avisa: *"Nenhum clip de vídeo selecionado."* |
| **Clip mais curto que a duração** | Ajusta duração para o tamanho total do clip | Keyframe 2 é posicionado no fim do clip sem estourar os limites. |
| **Itens incompatíveis (ajuste, títulos, etc.)** | Verifica se `areKeyframesSupported()` é `true`; caso contrário, ignora com segurança. | `VALIDATE IN PREMIERE` |

---

## 7. Viabilidade Técnica & APIs Premiere UXP (Auditadas)

As seguintes APIs do Premiere UXP DOM (v24.2+ / v25.0+ / v25.6+) são as oficiais para este fluxo:

1. **Obter Sequência Ativa**:
   ```javascript
   const project = await app.Project.getActiveProject();
   const sequence = await project.getActiveSequence();
   ```
2. **Obter Seleção da Timeline**:
   ```javascript
   const selection = sequence.getSelection(); // TrackItemSelection
   const trackItems = selection.getTrackItems();
   ```
3. **Filtrar Clips de Vídeo (`getMediaType` é assíncrono)**:
   ```javascript
   const videoClips = [];
   for (const item of trackItems) {
     const mediaType = await item.getMediaType();
     if (mediaType === app.Constants.MediaType.VIDEO) {
       videoClips.push(item);
     }
   }
   ```
4. **Localizar Componente `Motion` via `VideoComponentChain`**:
   *(VideoComponentChain expõe `getComponentCount()` e `getComponentAtIndex(index)`)*
   ```javascript
   const chain = await clip.getComponentChain();
   const count = chain.getComponentCount();
   let motionComp = null;
   for (let i = 0; i < count; i++) {
     const comp = chain.getComponentAtIndex(i);
     const matchName = comp.getMatchName();
     const displayName = comp.getDisplayName();
     // Identifica o componente Motion (ex: matchName ou displayName)
     if (matchName === "ADBE Motion" || displayName === "Motion") {
       motionComp = comp;
       break;
     }
   }
   ```
5. **Localizar Parâmetro `Scale` via `Component`**:
   *(Component expõe `getParamCount()` e `getParam(index)`)*
   ```javascript
   let scaleParam = null;
   if (motionComp) {
     const paramCount = await motionComp.getParamCount();
     for (let j = 0; j < paramCount; j++) {
       const param = await motionComp.getParam(j);
       const displayName = param.getDisplayName ? param.getDisplayName() : param.getName();
       const matchName = param.getMatchName ? param.getMatchName() : "";
       if (displayName === "Scale" || matchName === "ADBE Scale") {
         scaleParam = param;
         break;
       }
     }
   }
   ```
6. **Verificar Suporte e Estado de Keyframes**:
   ```javascript
   const keyframesSupported = await scaleParam.areKeyframesSupported();
   if (!keyframesSupported || scaleParam.isTimeVarying()) {
     // Ignora clip para preservar animação existente
     return;
   }
   ```
7. **Criar Ações de Keyframe e Sequência Correta**:
   *(Keyframe expõe propriedades `position` (TickTime) e `value` (number))*
   ```javascript
   const actions = [];

   // Passo A: Habilita animação (se não estiver ativa)
   actions.push(scaleParam.createSetTimeVaryingAction(true));

   // Passo B: Cria Keyframe 1
   const kf1 = scaleParam.createKeyframe(100.0);
   kf1.position = TickTime.createWithSeconds(startSeconds);
   actions.push(scaleParam.createAddKeyframeAction(kf1));

   // Passo C: Cria Keyframe 2
   const kf2 = scaleParam.createKeyframe(targetScale);
   kf2.position = TickTime.createWithSeconds(endSeconds);
   actions.push(scaleParam.createAddKeyframeAction(kf2));
   ```
8. **Execução Atômica e Undo**:
   ```javascript
   await project.executeTransaction((transaction) => {
     actions.forEach(action => transaction.addAction(action));
   }, "Aplicar Zoom");
   ```

---

## 8. Pontos Marcados como `VALIDATE IN PREMIERE`

*   `[VALIDATE IN PREMIERE 1]`: **Referência Temporal de `Keyframe.position`**: Validar se `TickTime` espera timestamp absoluto na timeline da sequência ou timestamp relativo ao In-Point do clipe na track.
*   `[VALIDATE IN PREMIERE 2]`: **MatchNames Canônicos de Motion & Scale**: Inspecionar no console do Premiere os retornos exatos de `comp.getMatchName()` e `param.getMatchName()` para garantir que a identificação funcione independentemente do idioma da interface (inglês, português, espanhol, etc.).
*   `[VALIDATE IN PREMIERE 3]`: **Interpolação Padrão dos Keyframes**: Confirmar se `createAddKeyframeAction` cria keyframes com interpolação linear por padrão ou se herda a interpolação do parâmetro.

---

## 9. Acceptance Criteria (Critérios de Aceite para V1)

1. [ ] Com a timeline aberta e 1 clip de vídeo selecionado, abrir a Tool Zoom e clicar em "Aplicar" insere 2 keyframes em `Motion > Scale`.
2. [ ] No modo `Zoom In`, o valor de escala evolui de 100% para o valor alvo (ex: 115%).
3. [ ] No modo `Zoom Out`, o valor de escala evolui do valor alvo para 100%.
4. [ ] Se múltiplos clips de vídeo forem selecionados, todos os clips válidos recebem a animação dentro da mesma transação.
5. [ ] Se um clip selecionado já possuir keyframes em Scale (`scaleParam.isTimeVarying() === true`), o plugin ignora o clip e não destrói os keyframes existentes.
6. [ ] Se nenhum clip de vídeo estiver selecionado (ou apenas áudio), a Tool exibe mensagem amigável e bloqueia a execução sem erros de runtime.
7. [ ] Executar `Ctrl+Z` / `Cmd+Z` no Premiere reverte toda a alteração de uma única vez (Undo atômico via `executeTransaction`).
8. [ ] A Tool fecha ou limpa o estado de feedback sem travar o Product Shell.

---

## 10. Out of Scope (Explicitamente Fora do MVP)

- Sem interpolação bezier avançada ou curvas de velocidade customizadas;
- Sem ajuste automático de `Position` (panning/re-enquadramento automático);
- Sem tracking de ponto ou reconhecimento de faces;
- Sem motion blur / desfoque de movimento artificial;
- Sem presets customizáveis salvos pelo usuário;
- Sem integração com IA ou processamento em nuvem;
- Sem suporte a clips de áudio ou transições de corte sobrepostas.
