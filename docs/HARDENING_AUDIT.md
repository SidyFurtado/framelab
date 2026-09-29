# Hardening Audit — Framelab (Premiere Pro / UXP)

**Data:** 2026-09-25 · **Versão auditada:** 0.4.1 · **Branch:** `main` (HEAD `2ccd1d3`)

Auditoria técnica de leitura, sem nenhuma alteração em código de produção. Cada
item tem arquivo, região, causa, impacto e correção recomendada. Nada aqui é
preferência de estilo ou de arquitetura: todo item é um comportamento observável
que pode dar errado no Premiere.

## Contagem

| Prioridade | Descrição | Quantidade |
|---|---|---|
| **P0** | Pode causar perda de dados ou deixar o plugin inutilizável | **2** (P0-1 resolvido · P0-2 parcial) |
| **P1** | Bug funcional importante | **5** (todos resolvidos) |
| **P2** | Performance / robustez | **10** (7 resolvidos: P2-8, P2-10, P2-11, P2-13, P2-14, P2-15, P2-17) |
| **P3** | Manutenção / limpeza | **5** |
| | **Total** | **22** |

## Resultado de build, typecheck e testes

| Comando | Resultado |
|---|---|
| `npm run typecheck` (`tsc --noEmit`) | **passa**, sem erros. `strict`, `noUnusedLocals`, `noUnusedParameters` e `noFallthroughCasesInSwitch` estão ligados |
| `npm run build` (`vite build`) | **passa** em ~0,8 s · 97 módulos · `dist/index.js` 902,86 kB (gzip 234,10 kB), `dist/index.css` 311,83 kB (gzip 180,58 kB) |
| `npm test` (`node --test`) | **passa** — 315 testes, 59 suites, 0 falhas, 1,08 s |
| lint | **não existe** — nenhum eslint/biome/oxlint configurado e nenhum script `lint` (ver P3-18) |

Avisos do build/teste, sem impacto funcional: `The CJS build of Vite's Node API
is deprecated` e `MODULE_TYPELESS_PACKAGE_JSON` em cada arquivo de teste (falta
`"type": "module"` no `package.json`).

---

# 1. Stack e arquitetura

**Stack:** TypeScript 5.6 em modo `strict`, sem framework de UI e sem
dependências de runtime. Build por Vite 5.4 em um único bundle **IIFE**
(`dist/index.js`) porque o UXP carrega um script clássico a partir do
`index.html`. Testes com o runner nativo do Node (`node --test`) via um loader
TS em `test/register.mjs`. Tipos do host por `@adobe/premierepro` e
`@adobe/cc-ext-uxp-types` — ambos apenas `devDependencies`.

**Host:** UXP `manifestVersion: 5`, `host.app: premierepro`,
`minVersion: 25.0.0`. Permissões pedidas: `localFileSystem: fullAccess`,
`network.domains: all` e `launchProcess` para esquema `file:`.

**Arquitetura em três camadas:**

1. **Product Shell** (`src/shell/`) — dona da barra superior, do navegador, do
   cabeçalho, da tira de seleção, da barra de ação e da barra de status. Um
   catálogo estático (`catalog.ts`) lista as 11 Tools. O contrato Shell↔Tool
   está em `tool.ts` (`mount`/`unmount` + `ToolContext`).
2. **Bridge** (`src/bridge/`) — único ponto de contato com o módulo
   `premierepro` (`premiere.ts`), persistência de ajustes por ferramenta
   (`settings.ts`) e a pasta de destino compartilhada entre ferramentas
   (`destination.ts`).
3. **Tools** (`src/tools/<tool>/`) — uma pasta por ferramenta, cada uma com o
   seu arquivo de UI (`*Tool.ts`) e os seus módulos puros de plano/aplicação
   (`apply*.ts`, `plan*.ts`), o que é o que permite testar a lógica fora do
   host.

**Tamanho:** ~38,5 kLOC em 97 arquivos de `src/`. Os maiores:
`download/ytdlp.ts` (2.258), `organize/applyOrganize.ts` (1.930),
`silence/applySilence.ts` (1.755), `sfx/sfxTool.ts` (1.615),
`flow/applyFlow.ts` (1.456), `download/downloadTool.ts` (1.385),
`zoom/applyZoom.ts` (1.297).

## Entrypoints

| Camada | Arquivo | Papel |
|---|---|---|
| Painel | `static/index.html` → `dist/index.js` | script clássico que o UXP carrega |
| Bootstrap | `src/main.ts` | `bootstrap()` em `DOMContentLoaded`; qualquer throw vira o painel de erro `renderFatal` em vez de um retângulo vazio |
| Shell | `src/shell/ProductShell.ts` | `constructor` monta o DOM inteiro; `start()` liga batimento do agente, sonda de capacidades, seleção e updater |
| Catálogo | `src/shell/catalog.ts` | as 11 Tools, em ordem de navegador |
| Host | `src/bridge/premiere.ts` | `getPremiere()`, `readSelection()`, `collectSelectedVideoClips()`, `checkHostCapabilities()` |

## Comunicação com o Premiere

Três canais, todos passando pelo bridge ou por um módulo dedicado:

1. **Leitura da timeline** — `require("premierepro")` resolvido em
   `getPremiere()`. `readSelection()` e `collectSelectedVideoClips()` leem as
   faixas em paralelo (`Promise.all` por faixa e por item) porque rodam na
   abertura do painel e a cada foco de janela.
2. **Escrita** — sempre `project.lockedAccess(() => project.executeTransaction(…))`
   com rótulo de undo. Os handles são relidos depois de cada commit, porque um
   handle capturado antes da transação responde *"The script object is no longer
   valid"*. Usado por `applyZoom`, `applyFlow`, `applySilence`, `applyOrganize`,
   `applyCaptions`, `sfx/insert`.
3. **Mundo externo (ffmpeg, yt-dlp, whisper, afplay)** — o UXP não tem
   `child_process`, e `shell.openPath` pede consentimento **por chamada**. A
   saída é o **agente residente** (`src/tools/download/runner.ts`): um `.app`
   (macOS) ou `.vbs` (Windows) gerado em disco que fica num laço lendo uma fila
   de arquivos `agent-go-*.txt`. O painel escreve o script, enfileira um
   ticket, e faz *polling* de arquivos de resultado. Um consentimento por
   sessão em vez de um por ação. O plano B — `openPath` direto, com Terminal —
   continua inteiro para quando o agente não sobe.

**Identidade de clipe:** o Premiere não expõe id único em track item, então
`clipIdentity()` deriva `v<faixa>|<nome>|<inTicks>|<outTicks>`, com sufixo de
ocorrência para cópias, e cai para uma chave posicional quando a leitura falha.

**Pasta de trabalho:** `src/tools/silence/workspace.ts` **descobre** a pasta
gravável em tempo de execução (testa `plugin-data:`, `plugin-temp:` e caminho
nativo, escrevendo e relendo uma sonda), e mantém os dois endereços de cada
pasta — o de esquema para o `fs` do UXP, o nativo para o ffmpeg e o `openPath`.

## Observação geral sobre a qualidade atual

O código é maduro e defensivo bem acima da média: quase todo `catch` tem um
comentário explicando a decisão, há degradação explícita para plano B em cada
caminho de processo externo, escapamento de HTML centralizado (`escapeHtml`),
`shellQuote`/`batValue` centralizados, rollback de transação no Zoom, snapshot
de undo no Silêncio e no Organizar, e validação do `version.json` vindo da rede.
Os achados abaixo são, em grande parte, **lacunas de consistência**: um padrão
já resolvido em um lugar e não aplicado em outro igual.

---

# 2. Achados

## P0 — perda de dados ou plugin inutilizável

### P0-1 · Atualização in-place não é atômica: uma falha no meio quebra o plugin sem volta

> **✅ RESOLVIDO em 2026-09-25.** A troca virou transação com ensaio, cópia de
> segurança e volta atrás, provada por 20 testes. Os limites do que ela **não**
> cobre estão no fim do item.

- **Arquivo:** `src/shell/updater.ts`
- **Região:** `PluginUpdater.applyUpdate()`, laço `for (const { filename, data } of downloads)` (linhas ~200–230)
- **Causa:** o download dos 4 arquivos é feito **inteiro em memória antes de
  gravar** — isso está correto e o comentário do código explica bem por quê.
  Mas a **gravação** é arquivo por arquivo, com
  `pluginFolder.createFile(filename, { overwrite: true })`, direto na pasta do
  plugin em execução, sem cópia de segurança e sem swap atômico. O `catch`
  externo só devolve uma mensagem; nada desfaz o que já foi gravado. A proteção
  existente cobre falha de **rede**, não falha de **escrita**.
- **Impacto:** se a gravação falhar no segundo dos quatro arquivos (disco cheio,
  permissão, host recusando `ArrayBuffer` num arquivo e não no outro, plugin
  recarregado no meio), a pasta fica com `index.html`/`manifest.json` da versão
  nova e `index.js`/`index.css` da antiga. O painel não abre mais, e o próprio
  atualizador — que vive dentro do bundle quebrado — não está lá para tentar de
  novo. Recuperação só reinstalando à mão.
- **Correção recomendada:** gravar em nomes temporários (`index.js.new`) e só
  então renomear todos, ou copiar os arquivos atuais para `.bak` antes do laço e
  restaurá-los no `catch`. A ordem também ajuda: gravar `manifest.json` por
  último, já que é ele que o host lê primeiro.

**O que foi feito**

Novo `src/shell/installBundle.ts` com `installBundle(target, files, onProgress)`:
a transação, atrás de uma porta estreita (`InstallTarget`: `writeFile`,
`readFile`, `deleteFile` e o opcional `replaceFrom`) que o teste implementa em
memória. `applyUpdate()` manteve consulta, download e validação como estavam; só
a fase de gravação passou a chamar a transação, com `pluginTarget()` traduzindo a
pasta do UXP para a porta. Quatro fases:

1. **Ensaio** — cada arquivo novo é gravado ao lado, com sufixo `.framelab-new`.
   É aqui que disco cheio, permissão e `ArrayBuffer` recusado aparecem, com
   nenhum arquivo ativo tocado. Cobre a falha mais provável — inclusive o caso do
   `index.js` de 900 kB, que é o último a ser ensaiado.
2. **Cópia** — os bytes de cada arquivo ativo vão para a memória **e** para um
   `.framelab-bak` ao lado. Não conseguir ler o ativo, ou não conseguir gravar a
   cópia, aborta **antes** da troca: uma troca sem volta é o que se quer evitar.
3. **Troca** — `replaceFrom` (rename, uma operação só) quando a build oferece;
   senão a escrita a partir da memória, que é o caminho que o atualizador sempre
   usou. Rename recusado no meio cai para a escrita sem abortar.
4. **Limpeza ou volta** — no sucesso, `.new` e `.bak` saem (e uma limpeza que
   falhe não derruba a atualização). Na falha, cada arquivo já trocado é
   restaurado **da cópia em memória** — a que não depende de o disco ter aceitado
   o `.bak`. Arquivo que não existia antes é apagado na volta.

`applyUpdate()` ganhou `critical?: boolean` no retorno (opcional, para não mexer
em quem consome os outros três campos). O `ProductShell` não foi tocado: a UX
segue a mesma — sucesso mostra "✅" e o botão Recarregar; falha mostra "⚠️" com a
mensagem e "Tentar via Navegador".

**Os dois finais aceitáveis, provados por teste:** falha antes da troca ⇒
instalação antiga intacta; falha depois de 1 ou 2 arquivos já trocados ⇒ os
trocados voltam e o disco fica **byte a byte** igual ao estado anterior, sem
rastros. Nenhuma versão misturada quando a volta é possível.

**Limites conhecidos (não cobertos pela transação):**

- **Host morto no meio da troca** (crash do Premiere, painel recarregado,
  processo morto) — nenhum código em processo pode reagir. É o que o `.bak` em
  disco existe para: ele não foi apagado ainda, e a mensagem crítica ensina a
  renomear. Com `replaceFrom` disponível, essa janela cai para "cada arquivo é o
  antigo ou o novo, nunca truncado"; sem rename, um `index.js` truncado é
  possível. Recuperação manual, não automática.
- **Volta atrás que falha** ⇒ `critical: true`, `.bak` e `.new` preservados, e a
  mensagem nomeia os arquivos não restaurados e diz como consertar à mão. É
  deliberadamente ruidoso: um estado misto que se anuncia é recuperável; um que
  se cala, não.
- **Sem verificação de integridade do que foi baixado** além de "não está vazio"
  — não há checksum no `version.json`. Um arquivo corrompido em trânsito mas com
  bytes é instalado como bom. Fora do escopo deste item.

### P0-2 · O snapshot de Desfazer do Corte de Silêncios só existe em memória

> **🟡 PARCIALMENTE RESOLVIDO em 2026-09-25.** A falha *tratável* depois da
> primeira mutação agora restaura a timeline **sozinha**, provado por 13 testes.
> O snapshot **continua sem persistência**, então crash/reload no meio da zona
> destrutiva segue sendo perda — registrado como risco residual no fim do item.

- **Arquivos:** `src/tools/silence/applySilence.ts`, `src/tools/silence/silenceTool.ts`
- **Região:** `applyCuts()` (linhas ~839–990) e a variável de módulo
  `let snapshot: CutSnapshot | null = null` (`silenceTool.ts:79`)
- **Causa:** `applyCuts` é destrutivo em dois passos por bloco: **1)**
  `removeRun()` tira os clipes originais da timeline; **2)** `writeSegments()`
  reescreve os trechos que ficam. Se o passo 2 falhar, a mensagem devolvida diz
  *"Use Desfazer corte para recuperar os clipes originais"* — e esse caminho
  depende inteiramente do `snapshot`, que vive numa variável de módulo. Ele
  sobrevive à troca de ferramenta (isso é deliberado e está comentado), mas
  **não** sobrevive a recarregar o painel, fechar o Premiere, o painel dar
  `renderFatal`, ou uma atualização do plugin.
- **Impacto:** janela real de perda de trabalho de edição. Com o passo 1 já
  executado e o snapshot perdido, a timeline fica com o buraco e a montagem
  original não é reconstruível pelo plugin. A mídia de origem continua nas bins,
  então não é perda de arquivo — é perda da edição, que numa sequência longa é o
  trabalho de horas.
- **Correção recomendada:** persistir o snapshot como JSON na pasta de trabalho
  logo depois do primeiro `removeRun()` bem-sucedido, apagá-lo quando a
  aplicação terminar inteira, e no `mount` reler um snapshot pendente para
  religar o botão Desfazer. A encanação já existe (`write`/`readText` de
  `workspace.ts`) e o mesmo padrão vale para `applyOrganize` (ver P2-9).

**Onde começa a zona destrutiva**

No **primeiro `removeRun()` bem-sucedido** do laço (`applySilence.ts`, hoje
~linha 930). Tudo antes — `openHost`, `identifyClips`, `planRun`, `groupIntoRuns`
— é leitura. O instante de risco é entre `removeRun` e `writeSegments`: ali a
montagem daquele bloco não existe em lugar nenhum a não ser na memória do painel.

**O que foi feito**

Novo `src/tools/silence/cutTransaction.ts` com `runCutTransaction(runs, rollback)`:
só a ORDEM — remover, registrar, escrever — atrás de três funções que o teste
implementa. `applyCuts()` manteve os passos e o algoritmo de detecção intactos; o
laço destrutivo passou a ser coordenado, e a volta atrás é o **mesmo mecanismo do
Desfazer manual** (`undoCuts`), não um segundo caminho de restauração.

- **Falha antes da primeira remoção** ⇒ `untouched`: erro cru, `snapshot: null`.
  Os dois painéis já tratam isso como "recusa seca" e devolvem o botão Aplicar.
- **Falha depois de mutar** (escrita recusada, remoção de um bloco posterior, ou
  uma exceção) ⇒ novas alterações param, `undoCuts` roda **automaticamente**, e a
  mensagem passou de *"Use Desfazer corte para recuperar os clipes originais"*
  para *"A timeline foi restaurada automaticamente ao estado anterior — nenhum
  corte foi aplicado"*, com o erro original preservado na frente. `snapshot: null`,
  porque não há mais nada a desfazer — e é o que mantém o plano válido para o
  editor tentar de novo.
- **Falha na volta atrás** ⇒ `critical`: mensagem começando em `FALHA CRÍTICA`
  com **os dois** erros (o original e o da restauração), a região tecnicamente
  afetada (faixa + relógio, via `describeTouched`), instrução para não fechar o
  painel, e o **snapshot preservado** — o "Desfazer corte" manual segue de pé como
  último recurso. Nada é descartado.

Um defeito latente do mesmo P0 caiu junto: `writeSegments` **lançando** (em vez de
devolver `ok:false`) subia até o `catch` externo de `applyCuts`, que devolvia
`snapshot: null` com a timeline já cortada pela metade — perda garantida. O
coordenador trata exceção de passo como falha de passo, com volta atrás.

Nenhuma outra ferramenta foi alterada: `fillersTool` compartilha `applyCuts` e a
melhoria vale para ela sem mudança de código, porque os quatro finais casam com a
lógica que os dois painéis já tinham (`if (result.snapshot)` liga o Desfazer;
`!ok && !snapshot` devolve o botão Aplicar).

**Persistência do snapshot: não implementada, deliberadamente**

Verificado: os dados **são** serializáveis (ids, ticks, índices de faixa) e existe
mecanismo simples e reutilizável (`write`/`readText` de `workspace.ts`, já usado
pelo `config` desta ferramenta). O único campo não serializável é
`originals[].projectItem`, e ele já é apenas reserva — `resolveProjectItem`
prefere reler o handle pelo `projectItemId`.

O que impede a gravação de ser pequena e segura não é o formato, é o que a
restauração faz: `clearRange()` **apaga a região** `[writtenStart, writtenEnd]`
antes de recolocar os originais. Um snapshot lido depois de um reload não sabe se
o editor continuou trabalhando naquela região — e aplicá-lo nesse caso destruiria
trabalho bom em vez de recuperar o antigo. Para ser segura, a recuperação após
reload precisa de validação de identidade (mesmo projeto, mesma sequência, região
ainda com o que a ida escreveu) e de uma confirmação explícita do editor no
`mount`. Isso é um fluxo novo de produto, não uma gravação — e a instrução desta
etapa é não inventar arquitetura para persistir o Undo. Fica registrado como o
próximo passo do grupo B, junto com o P2-9.

**Risco residual (por que não está totalmente resolvido)**

- **Crash, reload do painel ou processo morto dentro da zona destrutiva** ⇒ a
  montagem daquele bloco continua irrecuperável pelo plugin. A mídia nas bins
  sobrevive; o arranjo, não. É a única janela que sobrou, e ela não é coberta.
- **`undoCuts` depende do host responder.** Se o Premiere está no estado que
  causou a falha original (projeto travado, sequência fechada), a volta atrás
  tende a falhar pelo mesmo motivo — e o final é `critical`. O auto-rollback
  melhora o caso comum (uma escrita recusada), não uma sessão de host doente.
- **Efeitos e keyframes do track item não voltam** nem no auto-rollback nem no
  Desfazer manual: o overwrite os consome na ida. Isso é anterior a esta correção
  e está dito na interface da ferramenta.

## P1 — bug funcional importante

### P1-3 · `runApply` não tem `catch`: um throw no Apply deixa a ferramenta travada e muda

> **✅ RESOLVIDO em 2026-09-25** (o cerco na Shell). Um resíduo conhecido segue
> aberto — o preâmbulo de `organizeProject` — descrito no fim do item.

- **Arquivo:** `src/shell/ProductShell.ts`
- **Região:** `runApply()` (linhas ~715–734) — `try { await handler(); } finally { … }`, sem `catch`
- **Causa:** a Shell chama o handler com `void this.runApply()`. Como não há
  `catch`, qualquer exceção que escape do handler vira **unhandled rejection**.
  Cinco das onze Tools não têm `try/catch` próprio no handler de Apply — **zoom,
  flow, organize, silence, fillers** — e confiam em que a função `apply*` nunca
  lance. Essa confiança não se sustenta: em
  `applyOrganize.ts:1280`, `organizeProject()` faz
  `await ppro.Project.getActiveProject()` **fora** do seu `try` (que só começa na
  linha 1288), e é exatamente esse tipo de chamada que responde *"The script
  object is no longer valid"* quando o host está ocupado.
- **Impacto:** o Apply falha em silêncio. No caso do Organizar, o handler chama
  `context.setStatus("Organizando…")` e `setApplyEnabled(false)` antes; como
  `setApplyEnabled` marca `applyStateOwned`, o `finally` da Shell **não**
  reabilita o botão. O editor fica com "Organizando…" para sempre, botão morto,
  e nenhuma mensagem de erro — sem console, num painel UXP, isso é
  indepurável.
- **Correção recomendada:** `catch` em `runApply` que escreve o erro na barra de
  status com tom `error` (a Shell já sabe fazer isso) e loga no console; e mover
  as chamadas de preâmbulo de `organizeProject` para dentro do `try`.

**O que foi feito**

- Novo `src/shell/applyRun.ts` com `guardApplyRun(io: ApplyRun)`: a máquina de
  estados do Apply, **sem DOM e sem host**, com o contrato de **nunca rejeitar**
  — é isso que torna `void this.runApply()` uma chamada segura. Mora fora do
  `ProductShell` porque ele não é importável em teste (lê o define
  `__APP_VERSION__` no topo do módulo e o catálogo arrasta as onze Tools).
- `runApply()` virou o adaptador: mesma guarda de reentrada e mesmo preâmbulo,
  com o corpo delegado ao cerco. O caminho de sucesso é idêntico, inclusive o
  "não faz nada" quando `applyStateOwned` está ligado.
- **Semântica de `applyStateOwned`:** preservada para execução que *terminou*;
  deliberadamente **ignorada** quando a execução lançou. Uma decisão tomada com
  base num trabalho que não aconteceu não é uma decisão — é o que deixava o botão
  morto. Falha ⇒ o botão volta.
- **Erro visível** pelo mecanismo existente: `setStatus(…, "error")` na barra de
  status, com a frase no padrão do `failureMessage` do Baixar
  (`Falha ao aplicar: <causa>.`, via `describeError`) mais um `console.error`.
- **Tool trocada durante a falha** (`stale`): o botão fica desabilitado e o erro
  **não** vai para a barra — ela pertence à Tool que entrou. É a mesma regra do
  `live()` do `ToolContext`.

**Resíduo ainda aberto (não faz mais parte do impacto original):** o preâmbulo de
`organizeProject()` (`applyOrganize.ts:1280`) continua fora do seu `try`. Isso já
não trava o painel nem some com o erro — o cerco cobre —, mas a mensagem que o
editor vê vem crua do host (*"The script object is no longer valid"*) em vez da
frase com a fase que o resto da função produz via `phase`. Fica para o grupo C.

### P1-4 · Dois handlers no botão de atualizar: "Tentar via Navegador" reinstala por cima

> **✅ RESOLVIDO em 2026-09-25.** O botão passou a ter um listener só e uma ação
> corrente como fonte de verdade — provado por 10 testes de máquina de estados,
> incluindo não acumular listeners e não reentrar durante o trabalho.

- **Arquivo:** `src/shell/ProductShell.ts`
- **Região:** `showUpdateModal()`, ramo de falha do `btnUpdate.addEventListener("click", …)` (linhas ~428–448)
- **Causa:** quando `applyUpdate` falha, o código reaproveita o mesmo botão:
  troca o texto para "Tentar via Navegador" e faz
  `btnUpdate.onclick = () => this.updater.openDownloadPage()`. Mas o
  `addEventListener` original **continua registrado**. `onclick` e
  `addEventListener` coexistem — não se substituem.
- **Impacto:** o clique seguinte executa **os dois**: abre a página de download
  no navegador *e* dispara outra tentativa de atualização in-place, que
  desabilita o botão de novo, esconde o "Depois" e volta a gravar na pasta do
  plugin. Ou seja: a ação de fallback re-arma justamente a operação que acabou de
  falhar — e que é a do P0-1.
- **Correção recomendada:** um único caminho de registro. Guardar a função do
  listener e removê-la com `removeEventListener` antes de trocar o
  comportamento, ou manter um `mode` no closure e um só handler que decide.

**O que foi feito**

Novo `src/shell/actionButton.ts` com `actionButton(el)`: um listener registrado
**uma vez**, e a ação corrente numa variável que a troca de estado **substitui**.
A ação é lida no instante do clique, não capturada no registro — é o que faz o
botão executar o estado de agora e não o de antes. `showUpdateModal()` passou a
usar `update.set(rótulo, ação)` no lugar do par
`addEventListener` + `onclick`; nenhum `.onclick` restou no `src/`.

- **Reentrada:** além do `disabled` que a própria ação já liga, o controlador tem
  uma trava `running` — cliques repetidos durante uma instalação em curso não
  iniciam uma segunda, mesmo que quem desenha esqueça de desabilitar.
- **Rejeição:** o clique é disparado com `void`, então uma ação que estoure não
  teria dono; o controlador registra no console e libera a trava, em vez de deixar
  o botão preso em "trabalhando".
- Textos, ordem dos botões, progresso e comportamento visual continuam os mesmos.
  `installBundle()` e toda a transação do P0-1 não foram tocados — o `updater.ts`
  não mudou nesta etapa.

**Estados cobertos:** instalar (uma chamada de update), abrir no navegador
(somente navegador, zero updates), voltar a instalar / tentar novamente (um retry,
zero navegador), ação desligada e botão desabilitado (nenhuma ação).

**Risco residual**

- **O estado "Tentar Novamente" existe na máquina, mas a UI atual não o expõe:**
  hoje o ramo de falha vai direto para "Tentar via Navegador". O teste cobre a
  transição de volta para não deixar a porta aberta a uma regressão, mas essa
  volta não é um caminho que o editor consiga percorrer.
- **O dublê de teste modela o acúmulo por `addEventListener`, não o canal
  `onclick`** — que agora é impossível por construção, porque nada mais o
  atribui. Se alguém voltar a escrever `el.onclick = …` diretamente no elemento,
  o controlador não tem como impedir.
- **Os outros botões do modal** (`Baixar Manual`, `Depois`, `Recarregar Painel`)
  continuam com `addEventListener` direto. Cada um tem uma ação só que nunca muda,
  então não há o que acumular — mas eles não passam pela mesma garantia.
- **Nada foi executado no Premiere.** A prova é sobre a máquina de estados; o
  caminho real só se vê numa atualização que falhe de verdade.

### P1-5 · Prévia de SFX: nome de script fixo faz o agente executar o som errado

> **✅ RESOLVIDO em 2026-09-25.** Script, resposta e arquivo de erro passaram a
> ser carimbados por execução, com limpeza que só alcança a própria prévia —
> provado por 17 testes. O pid segue compartilhado de propósito; o porquê e o que
> sobrou estão no fim do item.

- **Arquivo:** `src/tools/sfx/native.ts`
- **Região:** `playNative()` (linhas ~60–120) e `stopNative()`; constantes `PLAY_SCRIPT`, `STOP_SCRIPT`, `STARTED_FILE`
- **Causa:** o script da prévia é sempre gravado no **mesmo nome de arquivo**,
  enquanto o agente executa **um trabalho por vez** e pode ter vários tickets na
  fila. Ouvir dois sons em sequência rápida — o gesto normal de quem procura um
  efeito numa lista — grava o script do som B por cima do script do som A
  *antes* de o agente ter executado o ticket A. O ytdlp, o whisper e o
  soundDesign já resolveram isto carimbando o nome do script por execução; este
  módulo não.
- **Impacto:** o ticket A executa o script de B, escrevendo o `tag` de B no
  arquivo de carimbo; o ticket B executa B **de novo** (matando o próprio
  `afplay` pelo arquivo de PID e reiniciando). Quem pediu A fica esperando o seu
  `tag`, não o vê, e recebe depois de 2,5 s o erro falso *"o assistente não
  respondeu em 2.5s"* — para um som que na verdade nunca foi tocado.
- **Correção recomendada:** carimbar `PLAY_SCRIPT`, `STOP_SCRIPT` e o arquivo de
  início por chamada (`sfx-play-<tag>.sh`), como `ytdlp.ts` faz com `runFiles`.

**O que foi feito**

Três artefatos passaram a ser exclusivos de cada chamada, no padrão que o `ytdlp`
e o `whisper` já usavam: `sfx-play-<tag>.command`,
`sfx-play-<tag>-started.txt` e `sfx-play-<tag>-error.txt`. A identidade saiu numa
função pura, `previewRun()`, e o texto do script em `previewScript(run, file,
space)` — é a menor costura que torna a identidade provável fora do host.

- **A etiqueta não é só o relógio.** `Date.now()` em milissegundos repete entre
  dois cliques rápidos, que é exatamente o caso a separar; agora há um contador de
  sessão junto (`p<ms>-<n>`), e um teste cria 200 prévias no mesmo milissegundo
  para provar que nenhum nome se repete.
- **O segundo caminho da colisão também fechou:** o `remove(STARTED_FILE)` que
  cada chamada fazia antes de escrever apagava a resposta de uma prévia anterior
  que já tivesse respondido. Com nome exclusivo não há o que pré-limpar, e a linha
  saiu.
- **A etiqueta dentro do carimbo continua**, agora como segunda cerca em vez de
  única defesa.
- **Limpeza isolada:** `runFiles(run)` lista os três artefatos daquela prévia e
  `forget()` remove só esses — em todas as saídas (sucesso, recusa do assistente,
  falha do afplay e timeout). Nenhuma limpeza alcança o script ou a resposta de uma
  prévia que ainda esteja de pé, porque os nomes são disjuntos. No timeout a ordem
  é `withdraw` e depois apagar, que é o que impede um assistente atrasado de tocar
  um som que ninguém espera mais.
- **O pid (`sfx-afplay.pid`) segue compartilhado, deliberadamente.** É por ele que
  uma prévia nova cala a anterior e que `stopNative` funciona: o script começa
  matando o pid que encontrar ali. Carimbá-lo por execução tiraria justamente
  isso. Um teste garante que ele **não** entra na lista de limpeza.
- **`STOP_SCRIPT` também segue com nome fixo**, e aqui a análise é diferente: o
  conteúdo dele só interpola o caminho do pid, então duas chamadas escrevem texto
  **idêntico**. Sobrescrever não muda o que é executado, e não há colisão
  observável — por isso ficou como estava.

A fila e a ordem são do `runner.ts` e não foram tocadas. A UI e `player.ts` também
não: `playNative` continua devolvendo `{ ok, detail }`.

**Risco residual**

- **A pasta de trabalho ganha três arquivos por prévia** em vez de reusar três
  nomes. São apagados em toda saída, mas um painel morto no meio de uma prévia
  deixa até três arquivos pequenos para trás — nomeados de forma reconhecível e
  inertes. Não há varredura de sobras antigas.
- **Uma prévia que estoura o prazo ainda pode ter o script executado** pelo
  assistente logo depois do `withdraw`, se a retirada perder a corrida. O som toca
  sem ninguém esperando por ele — e o `player.ts` já chama `stopNative` quando o
  resultado chega fora de tempo. É o comportamento anterior, não uma regressão.
- **Nada disso foi executado no Premiere.** Os testes provam a identidade e o
  isolamento dos artefatos, que é onde estava o defeito; a confirmação de ouvido é
  clicar rápido em três sons seguidos e conferir que o terceiro toca, que nenhum
  toca duas vezes, e que não aparece "o assistente não respondeu".

### P1-6 · Agente no Windows para de carimbar durante o trabalho: job duplicado e dois agentes

> **✅ RESOLVIDO em 2026-09-25.** O job passou a rodar destacado e oculto, com a
> espera (e o carimbo) por conta do laço do agente — provado por 24 testes sobre
> o script gerado, incluindo paridade de garantias com o bash. Continua sem
> execução real no Windows: ver o risco residual no fim do item.

- **Arquivo:** `src/tools/download/runner.ts`
- **Região:** `agentVbs()`, laço `Do … Loop` — `sh.Run "cmd /c …", 0, True` (linhas ~545–549)
- **Causa:** no Windows o agente executa o trabalho **de forma síncrona e
  bloqueante** (`True` = esperar terminar), com `Stamp` chamado só antes e
  depois. O carimbo de vida vale `ALIVE_GRACE_SECONDS = 8`. A versão bash não
  tem esse problema: ela roda o job em background e carimba dentro de um
  `while kill -0 "$pid"` justamente por isso — e o comentário do código diz que
  o Windows não pôde ser testado.
- **Impacto:** qualquer trabalho acima de 8 s — ou seja, praticamente todos:
  download, extração de áudio, transcrição — faz o painel ler o agente como
  morto. `stampVerdict()` devolve `"dead"`, o painel retira o ticket
  (`withdraw`) e abre o Terminal com diálogo de autorização: exatamente o que o
  agente existe para evitar. Pior, o guarda de instância única do `.vbs` é o
  mesmo carimbo velho (`If AgeOf(aliveF) < 8 Then WScript.Quit`), então um
  segundo agente sobe e os dois passam a disputar a mesma fila — trabalho
  duplicado (o mesmo vídeo baixado duas vezes, a mesma transcrição rodando em
  paralelo sobre os mesmos arquivos de saída).
- **Correção recomendada:** rodar o job assíncrono (`sh.Run …, 0, False`) e
  carimbar num laço enquanto ele vive (via `WScript.Shell.Exec` + `.Status`, que
  dá o equivalente do `kill -0`), e adicionar um lock de instância real —
  criação de pasta, como o `mkdir "$LOCK"` do bash — em vez de depender do
  carimbo.

**O que foi feito**

`Exec` foi descartado: ele tem `.Status` (o equivalente do `kill -0`), mas **não
sabe esconder a janela** — e a janela é metade do motivo de o agente existir. Em
vez disso o job é lançado **oculto e destacado** (`sh.Run …, 0, False`) dentro de
um invólucro `.bat` que o agente escreve na hora:

```bat
@echo off
call "<jobPath>"
> "<doneP>.tmp" echo %errorlevel%
move /y "<doneP>.tmp" "<doneP>" >nul
```

A espera passou a ser do próprio laço, carimbando a cada meia volta — o mesmo
desenho do `while kill -0` do bash:

```vbs
Do While Not fso.FileExists(doneP)
  Stamp
  WScript.Sleep 500
Loop
```

- **Término real:** o aviso só existe depois de `call` retornar, e `call` só
  retorna quando o job saiu. Verificado que todos os `.bat` gerados terminam em
  `exit /b` (que sai só do batch) e nunca em `exit` nu (que mataria o invólucro):
  os `exit 0` sem `/b` estão apenas nos scripts unix.
- **Aviso atômico:** `tmp` + `move /y`, a mesma disciplina que o carimbo de vida
  já usava — sem isso a espera veria o nome do arquivo antes do conteúdo.
- **Código de saída preservado** no conteúdo do aviso (antes o retorno do
  `Run(…, True)` era simplesmente descartado). O redirecionamento vem **antes**
  do `echo` de propósito: `echo 0> f` é lido pelo cmd como redirecionamento do
  handle 0, porque um dígito colado no `>` é número de handle — e 0 é justamente
  o código de saída mais comum.
- **Serial:** a espera fica dentro do `For Each` da fila, então um job por vez,
  como antes.
- **Instância única:** a guarda **é** o carimbo (`If AgeOf(aliveF) < 8 Then
  WScript.Quit 0`), e com o carimbo renovado durante o job ela deixa de ler
  "ocupado" como "morto". Nenhum redesenho de locking, como pedido. A mesma
  correção arruma a cadeia toda do painel: `agentState()` volta a responder
  `live` e `stampVerdict()` volta a responder `busy` em vez de `dead`.
- **Sobra de agente anterior:** o aviso é apagado antes do lançamento e os dois
  temporários são carimbados por execução (`agent-run-<n>.bat`,
  `agent-done-<n>.txt`) e removidos ao fim — um `.bat` sobrescrito enquanto
  executa é o defeito do P1-7, e não se repete aqui.
- **`AGENT_VERSION` subiu de 3 para 4**, que é o protocolo para o painel mandar um
  agente com o laço antigo sair antes de subir o novo. Sem isso um v3 já de pé
  continuaria servindo a fila com o defeito.

Unix/macOS não foi tocado. O formato da fila, dos tickets e dos arquivos de
resultado não mudou.

**Risco residual**

- **Nunca foi executado num Windows real.** A prova é sobre o texto gerado. A
  rede de segurança de quem chama — esperar o carimbo de início e cair no
  Terminal — continua inteira, então um agente que não funcione lá degrada para o
  comportamento visível, não para ferramenta morta.
- **Se o `cmd.exe` do invólucro for morto** (Gerenciador de Tarefas, crash), o
  aviso nunca chega e o laço espera carimbando para sempre: o agente vira um
  órfão que não processa mais a fila e não sai pelos 90s de carência, porque o
  sinal do painel não é checado durante o job — regra que o bash também segue. É
  mais estreito do que parece: matar o **job** não causa isso (o `call` retorna e
  o invólucro grava o aviso). Fechar essa janela pediria acompanhar o processo
  pelo PID, o que o `Run` não entrega.
- **O bash tem um lock de pasta (`mkdir "$LOCK"`) que o VBScript não tem.** A
  guarda do Windows continua sendo só o carimbo — suficiente agora que ele não
  expira durante o trabalho, mas ainda uma proteção mais fraca que a do Unix.

### P1-7 · Script de extração de áudio sem carimbo por execução: órfão executa o script novo

> **✅ RESOLVIDO em 2026-09-25.** O script virou o quarto artefato carimbado no
> Silêncios, e no Traduzir os três (script, saída e estado) passaram a ser
> exclusivos — provado por 26 testes. Com isso, os cinco P1 da auditoria estão
> fechados.

- **Arquivos:** `src/tools/silence/ffmpeg.ts`, `src/tools/translate/source.ts`
- **Região:** `extractAudio()` — `scriptName()` devolve `extract.command`/`extract.bat` fixo (linhas 111–112, gravado em 204, despachado em 215); em `source.ts`, `COPY_SCRIPT` (linhas 285–287)
- **Causa:** a correção de órfãos foi aplicada **pela metade**. Os arquivos de
  resultado, progresso e início são carimbados por execução (`sil-<tag>-*`), com
  um comentário explicando que é para o órfão escrever nos nomes velhos — mas o
  **script** continua num nome fixo. Um ticket que o agente pegue com atraso
  (fila longa, ou a fallback para Terminal já disparada) executa o texto que
  estiver em `extract.command` naquele instante, que é o da execução **seguinte**.
- **Impacto:** execução duplicada do ffmpeg sobre os **mesmos** arquivos de PCM
  de saída, em paralelo — o que pode deixar um `.wav` truncado que a detecção de
  silêncio depois lê como onda válida. E um `result.json` escrito duas vezes,
  podendo terminar a espera com o resultado de um processo que não é o esperado.
- **Correção recomendada:** carimbar o nome do script por execução, como
  `ytdlp.ts` já faz (`scriptName(launch.tag)`), e incluir o script anterior no
  rodízio de limpeza.

**O que foi feito — `ffmpeg.ts`**

`ExtractionRun` reúne os quatro artefatos, e o script entrou no grupo:
`extract-<tag>.command` / `extract-<tag>.bat`. A grafia de resultado, progresso e
início **não mudou** (`sil-<tag>-*`) — é contrato com o texto do script. A etiqueta
ganhou um contador junto do relógio, porque duas execuções no mesmo milissegundo
compartilhariam *todos* os artefatos, que é o defeito de volta e pior.

`extractionScript()` passou a devolver o texto já substituído, como valor — o que
torna a identidade provável fora do host. `extractionRun(windows)` e
`extractionScript(…, windows)` aceitam a plataforma por parâmetro para os nomes das
duas serem testáveis, a mesma saída que `fontFolders` já usava.

**Rodízio:** `runFiles(run)` lista os quatro, e `extractAudio` apaga os da execução
**anterior** no início da nova, registrando os seus para a seguinte — o padrão do
`ytdlp.ts`. Sem isso, cada varredura deixaria um script na pasta para sempre.
Apagar é seguro mesmo com um órfão lendo: no Unix o descritor aberto sobrevive ao
unlink, e no Windows a recusa do sistema deixa o arquivo onde está.

**O que foi feito — `source.ts`**

Aqui o risco era **pior**, e não derivado: os três nomes eram fixos, inclusive o
**arquivo de saída**. Escolher uma legenda e logo outra fazia a segunda
sobrescrever o script antes de o ticket da primeira rodar — e, porque a saída
também era compartilhada, quem pediu a legenda A recebia o **conteúdo da B**, com
`ok` no estado e nada na tela. Uma tradução da legenda errada, em silêncio.

`copyRun()` carimba script, saída e estado; `copyScript()` é o texto como valor. O
laço de pré-limpeza saiu (não há resto de outra cópia a limpar, e era ele que
apagava a saída de uma cópia vizinha), e um `finally` remove os três em toda saída
— sucesso, `cp` recusado, vazio, assistente negado e timeout.

**Efeito colateral corrigido junto:** três mensagens mandavam o editor dar duplo
clique em `extract.command` pelo nome (`ffmpeg.ts` e duas em `silenceTool.ts`).
Com o script carimbado, elas apontariam um arquivo que não existe — justamente na
via manual, que é a que importa quando o agente é recusado. As duas do painel
passaram a tirar o nome do `scriptPath` que já recebiam; a de `describeExtractionError`,
que não tem o caminho em escopo, deixou de nomear arquivo e aponta para o caminho
completo que o bloco de execução manual já mostra ao lado.

**Decisão sobre helper compartilhado:** avaliado e recusado. Os conjuntos de
artefatos são diferentes (quatro contra três, com extensões por plataforma num
caso e não no outro), e a única peça comum seria o gerador de etiqueta — duas
linhas. Mudanças locais pequenas em cada módulo, como a tarefa pedia.

**Risco residual**

- **A etiqueta é por processo do painel.** Um reload reinicia o contador, então dois
  painéis vivos na mesma pasta de trabalho poderiam gerar a mesma etiqueta no mesmo
  milissegundo. Não é um cenário do produto (um painel por instância do Premiere),
  mas o contador não é um GUID.
- **O rodízio do `ffmpeg.ts` apaga os artefatos da execução anterior**, e se ela
  ainda estiver de pé (uma varredura nova iniciada sobre uma antiga abandonada), o
  script dela sai debaixo do órfão. É o comportamento documentado do `ytdlp.ts` e a
  razão pela qual apagar é seguro nos dois sistemas — mas é uma escolha, não uma
  garantia de que o órfão termina.
- **No `source.ts` a limpeza é imediata**, então um `withdraw` que perca a corrida
  deixa o agente copiar para um arquivo que já foi apagado: o `cp` grava em disco,
  ninguém lê, e sobram até dois arquivos pequenos. Mesma janela estreita do P1-5.
- **Nada disso foi executado no Premiere.** Os testes provam identidade e
  isolamento; a via manual (o duplo clique no script carimbado) é o caminho que
  mais pede uma conferência de olho, porque foi o que a renomeação mexeu.

## P2 — performance e robustez

### P2-8 · Nenhum `fetch` do plugin tem timeout ou cancelamento

> **✅ RESOLVIDO em 2026-09-25** (reaberto e fechado no mesmo dia: a primeira
> versão cobria só até os cabeçalhos). As sete chamadas passam por
> `fetchWithTimeout`, e o prazo cobre a operação **inteira** — cabeçalho e corpo,
> sob um relógio só. Uma limitação do runtime está registrada no fim do item: onde
> o `fetch` do UXP ignorar `signal`, a requisição subjacente continua viva embora
> o painel seja liberado.

- **Arquivos:** `src/shell/updater.ts` (2 chamadas), `src/tools/translate/engine.ts` (2), `src/tools/sfx/drive.ts` (2), `src/tools/download/panelFetch.ts` (1)
- **Região:** todas as chamadas `await fetch(...)` do projeto
- **Causa:** verificado no código: nenhum `AbortController`, nenhum `signal`,
  nenhum deadline. A única exceção é `download/tiktok.ts:134`, que usa
  `Promise.race` com um timer — o que devolve o controle mas **não cancela** a
  requisição, que segue viva. `fetch` não tem timeout padrão.
- **Impacto:** uma conexão que abre e não responde (CDN do Drive engasgado, rede
  de escritório com captive portal, GitHub bloqueado) pendura a operação para
  sempre. As bandeiras de cancelamento existentes só são lidas **entre**
  requisições, então o botão de cancelar não tem efeito enquanto o `fetch` está
  pendurado. O editor só sai recarregando o painel — e no caso do pack de SFX
  isso também tranca qualquer sync novo (ver P2-13).
- **Correção recomendada:** um helper único `fetchWithTimeout(url, init, ms)` com
  `AbortController` (com fallback para o `Promise.race` atual se a build do host
  não tiver `AbortController`), usado pelos quatro módulos, com prazos
  diferentes por natureza da chamada (manifesto de versão: segundos; bytes de
  mídia: por bloco).

**O que o runtime oferece — verificado antes de escrever código**

O UXP declara `AbortController` e `AbortSignal` como globais
(`@adobe/cc-ext-uxp-types/uxp/index.d.ts:2003` e `:2015`). Mas a assinatura de
`fetch` da Adobe (`:1424`) aceita só `method`, `headers`, `body` e `credentials` —
**`signal` não está lá**. Ou seja: dá para criar o controlador, e não dá para
garantir que esta build o respeite.

Passar a chave assim mesmo é seguro, e há prova em produção: o `updater.ts` já
passava `cache: "no-store"`, que também não está naquela tipagem, e funciona.
Chaves extras em `init` são ignoradas, não recusadas.

**O que foi feito**

Novo `src/bridge/net.ts` com **duas defesas simultâneas**, e não uma escolha entre
elas, porque não há como detectar em tempo de execução se o `fetch` honra o sinal:

1. o `signal` de um `AbortController`, para a requisição ser abortada de verdade
   na build que o respeitar;
2. a corrida com um temporizador, que devolve o controle a quem chamou de
   qualquer jeito.

Contrato: `fetchWithTimeout(url, init, timeoutMs, externalSignal?)`. Um erro HTTP
**não** lança — a `Response` volta com `ok: false`, como sempre, porque é assim que
os quatro módulos decidem o que fazer com um 404 e um 429.

`NET_DEADLINE` centraliza os prazos, por requisição e não por operação:
`metadata`/`manifest` 20 s, `translate` 30 s, `listing` 45 s, `media` 120 s. Todos
folgados de propósito — uma rede de escritório lenta não pode ser confundida com
uma conexão morta.

**Prazo × cancelamento** são causas distintas (`NetTimeout` e `NetCancelled`, com
`isNetTimeout()` / `isNetCancelled()` por marca em vez de `instanceof`). Na build
que honra o sinal, quem rejeita primeiro é o próprio `fetch`, com um `AbortError`
genérico que não diz qual dos dois foi; um veredito guardado no helper traduz para
a causa certa. Um `signal` já abortado antes da chamada nem abre conexão.

Limpeza em `finally` em toda saída: o temporizador de dois minutos não fica de pé
depois de uma resposta que chegou em 50 ms, e o ouvinte do sinal externo não
sobrevive à chamada que o criou. Nenhuma promessa fica sem dono — `Promise.race`
pendura tratador em cada entrada, inclusive no `fetch` que rejeita depois de o
prazo já ter vencido.

**A lacuna que reabriu o item, e como fechou**

A primeira versão armava o prazo só até o `fetch` devolver a `Response` — e o
limpava ali. Só que a `Response` chega com os **cabeçalhos**: o corpo ainda não
veio. Um servidor que responda o cabeçalho e pare no meio do corpo deixava
`.json()`, `.text()` e `.arrayBuffer()` pendurados para sempre, com o temporizador
já removido e o ouvinte de cancelamento também. São **oito** leituras de corpo nos
quatro módulos, e nenhuma estava coberta: o prazo existia e não alcançava a parte
mais demorada da operação.

O prazo virou um **relógio de operação**: o instante-limite é calculado uma vez, no
começo, e cada etapa corre contra o que sobra dele. `underDeadline()` é usado tanto
pelo `fetch` quanto pela leitura do corpo, então as duas somam **um** prazo e não
dois — um cabeçalho que consuma 80 % do tempo deixa 20 % para o corpo, e um que
consuma tudo faz o corpo expirar na hora, sem prazo de graça.

A `Response` volta embrulhada num `Proxy` que intercepta só os leitores de corpo
(`json`, `text`, `arrayBuffer`, `blob`, `formData`) e deixa todo o resto passar
igual, com os métodos amarrados à resposta de verdade. Foi a forma de cobrir as
oito leituras **sem tocar em nenhum consumidor**: uma cópia montada à mão
esqueceria silenciosamente o que ninguém usou ainda. O mesmo `AbortController`
segue vivo até o corpo terminar, então abortar durante a leitura alcança o fluxo —
na build que honrar o sinal.

Um erro de parsing continua sendo erro de parsing: só o veredito do relógio vira
`NetTimeout`/`NetCancelled`; qualquer outra causa sobe como sempre subiu.

**Limitação do runtime, explícita:** onde o `fetch` do UXP ignorar o `signal`, a
requisição subjacente **continua viva** em segundo plano até o host desistir dela —
e isso vale igualmente para o corpo. O painel não fica preso, que é o que este item
pedia, mas o soquete pode demorar a fechar e os bytes que chegarem depois são
descartados. O aborto do corpo **não** está provado no UXP: a tipagem da Adobe não
declara `signal` no `fetch`, então o que se garante é a liberação do painel, não o
fechamento do fluxo. Está documentado no cabeçalho de `net.ts`.

**`tiktok.ts` não foi alterado:** não está na lista deste achado, e o
`Promise.race` de 8 s que ele tem já impede o chamador de ficar preso. O que falta
lá é só o aborto real — migrá-lo para o helper é uma limpeza para depois, sem
urgência.

**Deixado de propósito para P2-13 e P2-17:** as ferramentas cancelam com
**booleano** lido entre requisições (`cancelled?: () => boolean`, `job.cancelled`),
não com `AbortSignal`. O helper já aceita `externalSignal`, mas converter aquelas
bandeiras exigiria reestruturar os fluxos — que é exatamente o escopo do P2-13
(estado `running` do SFX) e do P2-17 (resultado parcial da tradução). Esta etapa
criou a infraestrutura para eles; a ligação é a próxima.

### P2-9 · O snapshot de Desfazer do Organizar também é só memória

- **Arquivos:** `src/tools/organize/applyOrganize.ts`, `src/tools/organize/organizeTool.ts`
- **Região:** `organizeProject()` / `undoOrganize()` e `lastSnapshot` no `mount`
- **Causa:** mesma causa do P0-2, num escopo menos destrutivo: o que se perde
  são movimentações de item entre bins e bins criadas, não recortes de timeline.
  O comentário do handler já reconhece que uma aplicação pode morrer entre as
  fases deixando as bins criadas no projeto.
- **Impacto:** com o painel recarregado depois de uma organização parcial, o
  editor fica com bins novas e itens movidos e sem o botão que desfaz —
  refazendo à mão o que numa árvore grande são centenas de movimentos.
- **Correção recomendada:** persistir junto com o do P0-2, na mesma encanação.

### P2-10 · O caminho sem `Range` do download no painel carrega o corpo inteiro antes de checar o teto

> **✅ RESOLVIDO em 2026-09-25.** O teto passou a valer ANTES de tocar no corpo, e
> sem `Content-Length` a leitura é feita em partes com o teto na mão — 22 testes,
> incluindo a prova de que o corpo não é lido no caso recusado.

- **Arquivo:** `src/tools/download/panelFetch.ts`
- **Região:** `fetchAllBytes()`, ramo `if (response.status === 200)` (linhas ~181–193)
- **Causa:** o teto de 300 MB foi corrigido para o caminho de blocos (206) —
  há um comentário longo e correto sobre isso. Mas no caminho 200 (servidor que
  ignora `Range`) o código faz `await response.arrayBuffer()` **e só depois**
  compara `whole.byteLength > MAX_BYTES`. A verificação acontece quando o dano
  já está feito.
- **Impacto:** um link que resolva para um arquivo muito maior do que se espera —
  CDN devolvendo a playlist inteira, link trocado, resposta de erro grande —
  carrega tudo na memória do painel UXP antes de ser recusado. O painel fica sem
  memória e morre; no UXP isso derruba o painel, não só a operação.
- **Correção recomendada:** ler `content-length` do cabeçalho e recusar antes de
  tocar no corpo; quando ele não vier, continuar em blocos com o teto do 206.

**O que foi feito**

`readWholeCapped()` substitui o `arrayBuffer()` cru do ramo 200, com três camadas,
da mais barata para a mais cara:

1. **tamanho declarado acima do teto** → recusa **sem tocar no corpo**. A leitura
   é numérica (`"9" > "10"` como texto seria o erro clássico), e um valor
   astronômico volta como número — inclusive `Infinity` —, não como "desconhecido":
   ele *é* conhecido por passar do teto, e tratá-lo como ausente adiaria a recusa
   para depois de começar a receber bytes.
2. **corpo legível em partes** (`response.body.getReader()`, que a tipagem do UXP
   declara) → lê com o teto na mão e para no instante em que o passaria, soltando
   o fluxo com `cancel()`. Esta camada é também o que segura um `Content-Length`
   **mentiroso**, que a camada 1 sozinha deixaria passar.
3. **sem leitura em partes nesta build, mas com tamanho declarado dentro do teto**
   → o `arrayBuffer()` de sempre, limitado pelo que o servidor prometeu.

Sem nenhuma das três — 200 sem `Content-Length` utilizável e sem `body` — a
resposta é **recusada**, e o trabalho cai para o script do yt-dlp, que sabe baixar
arquivo de qualquer tamanho. Ler tudo para medir depois era o defeito; não há
caminho que ainda faça isso.

**Cabeçalho inválido não vira passe livre:** ausente, vazio, com letra, negativo,
com sinal, decimal ou com sufixo caem todos em "desconhecido", que leva à camada 2
(ou à recusa), nunca à leitura às cegas.

O ramo **206 não mudou** — já era limitado, conferindo `received > MAX_BYTES` a
cada bloco de 4 MB. As duas mensagens passaram a usar a mesma constante.
Cancelamento e o prazo do P2-8 seguem valendo, inclusive dentro da leitura em
partes.

**Risco residual**

- **A camada 3 confia no `Content-Length`.** Numa build sem `response.body`, um
  servidor que declare 1 MB e envie 2 GB ainda passa. É mais estreito que o
  defeito original (que não checava nada) e só existe onde não há leitura em
  partes; fechá-lo de vez exigiria recusar todo 200 sem stream, o que tiraria o
  download no painel de builds que hoje funcionam.
- **O teto continua sendo 300 MB na memória do painel.** Um arquivo de 299 MB é
  aceito e mora inteiro na memória — é a política de sempre, não deste item.
- **`response.body` não foi exercitado no Premiere.** Está na tipagem do UXP
  (`Response.body: ReadableStream` com `getReader()`), e a ausência tem caminho de
  degradação, mas só uma execução real diz qual das três camadas vale nesta build.

### P2-11 · O *polling* do download lê o log inteiro do disco, de forma síncrona, a cada segundo

> **✅ RESOLVIDO em 2026-09-25.** A cauda passa a sair do fim do arquivo por
> `open`/`read` num offset, com teto de 8 KB por consulta — o custo deixou de
> depender do tamanho do log. 16 testes, incluindo a prova de que um log de 8 MB
> pede os mesmos bytes que um de 1 MB.

- **Arquivo:** `src/tools/download/ytdlp.ts`
- **Região:** `tail()` (linhas ~866–880) e `readProgress()` (linha ~859), chamadas no laço de `run()` a cada `tick % 4 === 0`
- **Causa:** `tail()` fatia os últimos 4096 caracteres — e o comentário diz que é
  para evitar custo linear a cada volta. Mas `tail()` chama `readText()`, que faz
  `fs.readFileSync(...)` do **arquivo completo** em UTF-8 antes de fatiar. A
  otimização cortou o `split`, não a leitura.
- **Impacto:** num lote longo (`DOWNLOAD_TIMEOUT_MS` chega a 90 minutos) com log
  na casa dos megabytes, são duas leituras síncronas do arquivo inteiro por
  segundo, na thread da UI do painel. É o que faz o painel engasgar durante
  downloads grandes, exatamente quando o editor está olhando a barra.
- **Correção recomendada:** ler só a cauda com `fs.open`/`fs.read` num offset — a
  interface `UxpFs` de `workspace.ts` já declara `open`, `read` e `close`
  justamente para isso (usadas hoje por outro leitor). Alternativa mais simples:
  o script rotacionar o log, mantendo só as últimas N linhas.

**O que foi feito**

`readTailText(space, name, maxBytes, fs)` em `workspace.ts`, ao lado do `readText`
que ele substitui no caminho quente: o tamanho vem do `lstatSync`, a leitura
começa em `size - janela` e para na janela, e o descritor fecha num `finally`.
`tail()` do `ytdlp.ts` passou a chamá-lo — virou `async`, e os quatro pontos de
chamada (o do polling e os três de encerramento) agora esperam.

- **Teto por consulta: `TAIL_WINDOW_BYTES = 8192`.** Generoso sobre os 4096
  caracteres que o consumidor aproveita — sobra margem para um corte no meio de um
  caractere e para linhas longas — e continua sendo um teto. Um teste mede que um
  log de 1 MB e um de 8 MB pedem exatamente a mesma quantidade de bytes.
- **UTF-8:** a janela começa num byte qualquer, então o primeiro caractere pode
  vir cortado. O `TextDecoder` devolve o pedaço órfão como U+FFFD e decodifica o
  resto corretamente; basta tirar esse prefixo — sem parser. Um teste varre **todos**
  os cortes possíveis dentro de `"🎬 cortou aqui · ação"` e exige que nenhum deixe
  substituição nem corrompa o fim.
- **Semântica preservada:** inexistente e vazio devolvem o mesmo de antes; arquivo
  menor que a janela é lido inteiro (sem abrir descritor); o resultado sai aparado,
  como o caminho antigo sempre saiu.
- **Arquivo mudando debaixo da leitura:** crescer não é erro (a janela é do
  instante da medição, e a volta seguinte pega o resto); truncar ou rotacionar
  entre medir e ler devolve `null`, que o polling trata como "sem log agora".
  Nenhuma exceção nova escapa.
- **Degradação:** build sem `lstatSync` ou sem `TextDecoder` cai no caminho antigo,
  que lê tudo. Melhor ler demais do que não mostrar o log.

`readProgress()` **não** foi tocado: ele lê `dl-<tag>-progress.txt`, um arquivo de
poucos bytes, e não era o gargalo. Frequência do polling, formato do log, script,
rotação e barra de progresso seguem como estavam.

Uma correção de arrasto entrou junto, e é pequena: `readText` passou a delegar a um
`readWhole(fs, path)` privado, para o caminho de degradação da cauda usar o mesmo
`fs` recebido em vez do global. Sem isso a degradação era intestável — dois testes
falharam exatamente por aí — e haveria duas definições de "o arquivo inteiro como
texto".

**Risco residual**

- **As duas leituras integrais do fim de `run()` continuam existindo** (linhas 764
  e 832): `parseDownloadedFiles` e `parseCookieTrouble` precisam do log inteiro,
  porque a nota dos cookies é a primeira linha e a lista de arquivos pode estar
  muito acima das 12 últimas. Elas rodam **uma vez**, no encerramento, não no
  polling — fora do escopo deste item, mas num lote de 90 minutos ainda é um
  `readFileSync` de vários MB de uma só vez.
- **`lstatSync` não foi exercitado no Premiere.** Está na tipagem do UXP e o
  caminho de degradação cobre a ausência, mas se a build devolver um `size`
  incorreto (e não um erro), a janela sairia do lugar errado — o resultado seria um
  log truncado ou vazio, nunca uma exceção.
- **Se o log tiver muito caractere multibyte**, 8192 bytes rendem menos de 4096
  caracteres, e a cauda fica mais curta que antes. O consumidor usa 12 linhas, e o
  log do yt-dlp é essencialmente ASCII, então não muda nada na prática.

### P2-12 · Um `saveManifest()` por som baixado: 8.540 reescritas do mesmo arquivo

- **Arquivo:** `src/tools/sfx/store.ts`
- **Região:** `fetchToFolder()`, `void saveManifest()` ao final de cada arquivo (linha ~292); `saveManifest()` nas linhas 143–158
- **Causa:** cada som gravado em disco dispara uma reescrita **completa** do
  manifesto (`JSON.stringify(manifest)`), encadeada na corrente `saving`. O
  encadeamento evita corrida — está certo — mas não reduz o volume.
- **Impacto:** num sync do pack inteiro (8.540 sons, segundo o pack real), são
  8.540 serializações e gravações de um JSON que cresce até centenas de KB, mais
  as chamadas de `markEmpty`/`rememberSeconds`. Trabalho quadrático em disco
  durante horas, competindo com o próprio download por I/O.
- **Correção recomendada:** aplicar o padrão de debounce que já existe em
  `bridge/settings.ts` (`DEBOUNCE_MS`, `flush()`): agendar a gravação e forçar um
  `flush` no fim de `runSync` e no `unmount`.

### P2-13 · Cancelar o sync de SFX pode deixar `running` preso para sempre

> **✅ RESOLVIDO em 2026-09-25.** Cancelar larga a guarda na hora, aborta a
> requisição em voo e para os workers; um job cancelado não consegue mais tocar
> num job iniciado depois — 21 testes. A ressalva do runtime está no fim do item.

- **Arquivo:** `src/tools/sfx/sfxTool.ts`
- **Região:** `runSync()` (linhas 225–270); cancelamento em 1202 e 1469 (`sync.cancelled = true`)
- **Causa:** `job.cancelled` só é lido no **topo de cada iteração** do worker. Um
  `downloadSound` em voo não é abortado (P2-8), então o worker fica parado dentro
  do `await` e `job.running` continua `true`. E `running` é a guarda de tudo: os
  testes `sync?.running` nas linhas 496, 907, 1151, 1220, 1241, 1296, 1310, 1512.
- **Impacto:** com uma conexão pendurada, o editor cancela, a UI continua dizendo
  que está baixando, e **nenhum** download novo pode começar até o painel ser
  recarregado. O botão de baixar categoria, o de baixar o pack e a prévia ficam
  todos inertes sem explicação.
- **Correção recomendada:** abortar a requisição em voo no cancelamento (junto
  com P2-8) e marcar `running = false` assim que o cancelamento é pedido,
  deixando os workers apenas drenarem.

**O que foi feito**

Novo `src/tools/sfx/syncJob.ts` com a máquina de estados do download —
`createSyncJob`, `stopSyncJob` e `drainSync`. O `runSync` virou o chamador fino;
`sfxTool.ts` não perdeu nenhuma regra de produto.

- **Cada execução tem o seu `AbortController`**, guardado no job. `stopSyncJob`
  faz três coisas numa: marca `cancelled`, **derruba `running` na hora** e chama
  `abort()`. É a derrubada imediata que devolve a ferramenta ao editor sem esperar
  uma conexão morta — a guarda não fica mais amarrada ao fim dos workers.
- **O sinal chega ao `fetch`** por três parâmetros opcionais, o caminho mínimo:
  `drainSync` → `copyToDisk(variant, nome, signal)` → `fetchToFolder` →
  `downloadSound(id, signal)` → `fetchWithTimeout(..., signal)`, usando o
  `externalSignal` que o P2-8 já expunha. Nada mais da camada de Drive mudou.
- **Job antigo não contamina job novo:** a identidade do próprio objeto é o token.
  `drainSync` recebe `current()` (em `sfxTool`, `sync === job`) e a consulta antes
  de pegar cada item, antes de cada redesenho e antes do encerramento. Um worker
  de A que termine tarde não baixa a guarda de B, não redesenha por cima dele e
  não troca o job corrente — e para de pegar trabalho assim que B entra em cena,
  mesmo sem cancelamento.
- **Cancelar não é erro:** `downloadSound` deixou de disfarçar `NetCancelled` de
  "sem conexão com o Drive", e `drainSync` não conta o item cancelado em `failed`
  nem em `done` — então `reportSync` não monta a mensagem de falha com tom
  `error`. Prazo vencido e erro de verdade continuam contando como sempre.
- **Idempotência:** `stopSyncJob` devolve se havia mesmo algo de pé, e só aí o
  `haltSync` redesenha. Cancelar duas vezes, ou cancelar um job já concluído, não
  faz nada.
- **UX:** a frase "Parando depois dos arquivos em andamento…" saiu dos dois botões
  de parar — ela descrevia a espera que não existe mais, e agora quem fala é o
  `reportSync` ("Download parado: N de M em <pasta>"), na hora.

**Quando o UXP ignora o `signal`:** o `fetchWithTimeout` libera a promessa de
qualquer jeito (prazo da operação inteira, ver P2-8), e o estado lógico daqui não
depende do soquete ter fechado. A guarda cai no clique; um resultado que chegue
atrasado cai num job que já não é o corrente e não altera nada. Nenhum processo
externo foi criado para matar soquete.

**Risco residual**

- **`copyToDisk` compartilha downloads do mesmo id** (`inflight`). Se a prévia e o
  sync estiverem baixando o mesmo som, cancelar o sync aborta a requisição que a
  prévia também espera. É estreito — exige o mesmo id nos dois ao mesmo tempo — e
  desfazer isso pediria mexer na deduplicação da camada de Drive, que esta etapa
  não podia tocar.
- **Workers de um job antigo que estejam dentro de um `await` seguem vivos** até a
  promessa deles resolver; o que se garante é que nada do que fizerem alcança a
  ferramenta. Com o `signal` honrado, resolvem na hora; sem ele, até o prazo do
  P2-8.
- **P2-14 continua aberto:** nada aqui impede dois `runSync` de começarem (a
  guarda checada antes do `await choose`). O que mudou é que o primeiro para de
  contaminar o segundo.
- **Nada foi executado no Premiere.** Os testes provam a máquina de estados; falta
  clicar em parar durante um download real e ver a ferramenta liberar.

### P2-14 · `downloadCategory` checa a guarda antes de um `await` que espera o editor

> **✅ RESOLVIDO em 2026-09-25.** A vez passou a ser adquirida no ponto central, em
> `runSync`, com a pergunta e a posse dentro da mesma função síncrona — 10 testes,
> incluindo o fluxo que volta do seletor de pasta.

- **Arquivo:** `src/tools/sfx/sfxTool.ts`
- **Região:** `downloadCategory()` (linhas 1240–1248)
- **Causa:**
  ```ts
  if (!catalog || sync?.running) return;      // guarda
  …
  if (!config.folder) await choose(true);      // abre o seletor nativo de pastas
  if (!config.folder || !alive) return;
  await runSync(catalog, categoryId);          // guarda não é reavaliada
  ```
  Entre a guarda e o `runSync` há um `await` de duração arbitrária — o diálogo
  nativo de escolher pasta. `runSync` também não reavalia nada: ele atribui
  `sync = job` e segue.
- **Impacto:** dois `runSync` simultâneos. O segundo substitui o `sync` do
  módulo, e os três workers do primeiro continuam baixando e reportando para um
  job que já não é o que a UI mostra — contadores errados na tela e o dobro da
  pressão sobre o Drive, que corta quem pede demais em paralelo.
- **Correção recomendada:** mover a guarda para dentro de `runSync` (uma marca
  síncrona no início, antes de qualquer `await`).

**O que foi feito**

`claimSync(current, hold)` em `syncJob.ts`: pergunta se há sync de pé e, se não
houver, cria o job e o entrega a `hold` — **dentro da mesma função síncrona**.
Entre o `if` e o `hold` não existe ponto de suspensão, então dois chamadores que
cheguem quase juntos não passam os dois. O `hold` existe porque a variável `sync`
vive no módulo da ferramenta: passá-la assim mantém a aquisição indivisível sem
trazer a variável para cá.

`runSync` adquire a vez na primeira linha e desiste em silêncio quando recusado. A
fila só é montada depois, e `job.total` é preenchido então — antes do primeiro
`notify`, para nada renderizar um total provisório.

Levantamento dos chamadores: `download()` **não** tinha a corrida (tudo entre a
guarda e o `runSync` é síncrono); só `downloadCategory()` tinha, por causa do
`await choose(true)`. As guardas externas continuam onde estavam — são úteis para
não abrir o seletor de pasta durante um download —, mas a segurança deixou de
depender delas.

**Uma tentativa recusada** não cria job, não cria `AbortController` e não encosta
em `sync`. Testado.

**Interação com o P2-13:** preservada e verificada. Cancelar derruba `running`
dentro de `stopSyncJob`, então a vez fica livre **na hora**, mesmo com um worker
antigo ainda preso num `await` — e o fim tardio desse worker não derruba a vez do
job novo, porque `drainSync` só encerra o job corrente. Um `try/finally` novo em
`runSync` solta a guarda se `drainSync` estourar: sem ele, uma exceção inesperada
deixaria a ferramenta inerte até recarregar, que é exatamente o defeito que o
P2-13 tirou.

**Risco residual**

- **A guarda protege o início, não o resto.** Dois cliques ainda podem disputar o
  mesmo instante; o que se garante é que só um vira job. O segundo desiste calado —
  sem mensagem —, que é o comportamento anterior das guardas externas, mas quem
  clicou não sabe por que nada aconteceu.
- **`claimSync` depende de quem chama passar o `sync` corrente.** Um caminho novo
  que crie `SyncJob` direto, sem passar por ele, fura a proteção. O nome e o
  comentário são a defesa; não há nada no tipo que impeça.
- **Nada foi executado no Premiere.** A corrida real exige abrir o seletor de pasta
  e disparar outro download nesse meio-tempo — a prova aqui é a da máquina de
  estados.

### P2-15 · `minPremiereVersion` é declarado, publicado e nunca verificado

> **✅ RESOLVIDO em 2026-09-25.** Dois portões: a atualização incompatível não é
> oferecida, e uma chamada direta de `applyUpdate()` é recusada antes de baixar um
> byte — 22 testes. O risco residual de `uxp.host.version` está no fim do item.

- **Arquivos:** `src/shell/updater.ts` (campo em `VersionManifest`, linha 11), `version.json` (linha 4: `"25.0.0"`)
- **Região:** `applyUpdate()` — o gate existente só compara versões do plugin (`isNewerVersion`)
- **Causa:** o campo está no tipo e no manifesto publicado, mas nada o lê. A
  única checagem de host é `checkHostCapabilities()`, que roda **depois** da
  atualização, no próximo start, e só sabe reclamar.
- **Impacto:** uma versão que passe a exigir uma API nova (o `manifest.json` do
  bundle já sobe o `minVersion`) é instalada em cima de um Premiere antigo. O
  resultado é o pior caso: o editor autorizou uma atualização e ficou com um
  painel que não abre ou que falha no meio do Apply.
- **Correção recomendada:** comparar `manifest.minPremiereVersion` com a versão
  do host antes de oferecer o selo e antes de gravar, e recusar com uma frase que
  nomeie a versão necessária.

**O que foi feito**

A versão do host vem da fonte que o projeto já tinha — `uxp.host.version`, a mesma
que `sfx/sfxTool.ts` usa para decidir se a timeline aceita arrasto —, agora
exposta em `bridge/premiere.ts` como `hostVersion()`. Nenhuma segunda forma de
perguntar isso foi inventada.

`compareVersions(a, b)` é numérica e mora ao lado: `25.10` vem **depois** de
`25.9` (onde a comparação de texto erra), segmento ausente conta como zero
(`25` = `25.0` = `25.0.0`), e o que não é versão devolve **`null`** — não zero.
Essa distinção é o item inteiro: `isNewerVersion` converte lixo em `0.0.0`, que
todo host atende, e reusá-la aqui seria instalar por dúvida.

- **GATE 1, a oferta** — em `checkForUpdates()`, logo depois de calcular
  `hasUpdate`: se o host não atende, devolve `hasUpdate: false` com a frase em
  `error` e um `console.warn`. O selo não aparece, porque oferecer uma atualização
  que deixaria o painel sem abrir é pior que não oferecer nenhuma.
- **GATE 2, a gravação** — em `applyUpdate()`, depois do gate de versão do plugin
  e **antes** do primeiro `fetch`: recusa com a mesma frase, que o modal já
  renderiza com ⚠️. Existe porque o primeiro é visual, e estado velho, corrida ou
  chamada direta furam o visual. Nada é baixado nem gravado.

A frase nomeia as duas versões: *"Esta versão do Framelab requer Adobe Premiere
Pro 25.0.0 ou superior. Você está usando 24.6.3."*

**Versões inválidas:** a dúvida bloqueia, como a política pede. Host ilegível e
`minPremiereVersion` mal escrito recusam a atualização automática, cada um com a
sua frase. Um teste pegou que a primeira versão do parser era tolerante demais —
`"25.x"` casava só o `25` e virava versão válida, furando o portão. A regra passou
a exigir que a versão **termine** no trecho pontuado: `"25.1.0 (Build 42)"` vale
(acaba num espaço), `"25.x"` não (continua num ponto).

**Manifestos antigos:** `minPremiereVersion` é **opcional** no contrato
(`minPremiereVersion?: string`), então ausência — e string vazia — não bloqueiam
nada. Uma release antiga que não traga o campo continua instalável como sempre.

`installBundle()`, o rollback, o download, a allowlist (P2-16) e o botão não foram
tocados.

**Risco residual**

- **Uma build do Premiere que não exponha `uxp.host.version`** deixaria de receber
  atualização automática, porque host ilegível bloqueia. É o preço escolhido da
  política "não instalar por dúvida", e o caminho manual ("Baixar Manual") segue
  aberto — mas se essa build existir, o editor só descobre pelo console.
- **O formato real do `host.version` neste Premiere não foi medido**: o parser é
  tolerante a `v`, espaço e sufixo de build, e o projeto já lia esse campo com
  `parseInt` para o major, o que sugere numérico pontuado. Uma forma inesperada
  cairia no bloqueio acima.
- **`minPremiereVersion` continua sendo uma promessa do manifesto**, não uma
  verificação de API: quem publica a release precisa manter o campo em dia com o
  `minVersion` do `manifest.json` do bundle. Nada automatiza essa coerência.

### P2-16 · Allowlist de URL do atualizador não normaliza o caminho

- **Arquivo:** `src/shell/updater.ts`
- **Região:** `applyUpdate()`, filtro `fileEntries` (linhas 164–173)
- **Causa:** o nome do arquivo é validado com rigor
  (`/^[A-Za-z0-9][A-Za-z0-9._-]*$/`, o que fecha `../`), e a URL é checada com
  `fileUrl.startsWith(allowedUrl)` mais uma recusa a `main|master|HEAD`. Mas o
  resto do caminho não é normalizado: `…/framelab/v1/../../outro/main/x` passa
  pelo `startsWith` e é normalizado pelo `fetch` para outro repositório.
- **Impacto:** defesa em profundidade furada, não buraco aberto — exige que o
  nosso próprio `version.json` já esteja comprometido, e nesse cenário o
  atacante já escolhe o conteúdo. Vale fechar porque é o caminho de entrega do
  plugin, onde o custo de um erro é o P0-1.
- **Correção recomendada:** recusar qualquer URL cujo caminho contenha um
  segmento `..`, e validar o formato da tag esperada.

### P2-17 · Motor de tradução reserva: serial, sem timeout, sem cancelamento e perde o lote

> **✅ RESOLVIDO em 2026-09-25.** Uma falha posterior não descarta mais o que já
> foi traduzido: o resultado volta parcial, com a contagem do que faltou, e o
> painel diz isso. 16 testes. O prazo por requisição veio do P2-8.

- **Arquivo:** `src/tools/translate/engine.ts`
- **Região:** `pedirMyMemory()` (linhas ~176–196) e o laço `for (const lote of lotes)` em `translate()`
- **Causa:** o MyMemory não aceita lote, então a reserva faz **uma requisição por
  fala, em série**. Dentro desse laço não há checagem de `options.cancelled` (ela
  só existe entre lotes) nem timeout. E qualquer `!resposta.ok` — o MyMemory
  limita taxa, então 429 é esperado num arquivo grande — devolve `null`,
  descartando **todas** as falas já traduzidas naquele lote.
- **Impacto:** num `.srt` de algumas centenas de legendas, a reserva vira
  centenas de requisições sequenciais que o editor não consegue interromper, e
  que podem terminar em "both-engines-failed" depois de minutos, sem entregar
  nada do que já tinha vindo.
- **Correção recomendada:** checar `cancelled` a cada fala, timeout por
  requisição (P2-8), e devolver resultado parcial com a contagem do que faltou em
  vez de descartar o lote.

**As duas perdas, que eram distintas**

1. `pedirMyMemory` acumulava as traduções em `saida` e devolvia **`null`** ao
   primeiro tropeço — jogando fora tudo que já tinha vindo naquele lote.
2. `translate` então devolvia `texts: []`, descartando também **os lotes que o
   Google já havia fechado**. Um 429 na fala 200 custava as 199 anteriores e todo
   o resto, com a mensagem "os dois tradutores recusaram".

**Contrato adotado**

`TranslateResult` ganhou dois campos **opcionais**: `done` (falas traduzidas) e
`pending` (falas que ficaram sem). `pending > 0` com `ok: true` **é** o resultado
parcial — as falas que faltaram mantêm o texto original, o mesmo que já acontecia
com as falas sem letra. `texts` continua alinhado, uma entrada por entrada.

A reserva deixou de devolver `null`: devolve `ReservaParcial` com o que conseguiu,
quantas faltaram, a causa e se foi desistência. Quem chama decide se aquilo é
parcial ou falha.

- **Zero traduções** → falha total como sempre (`both-engines-failed` /
  `engine-failed`, `texts: []`). Chamar de "parcial" o que não traduziu nada seria
  entregar o arquivo original com cara de tradução.
- **N traduções + falha** → `ok: true`, as N preservadas, `pending` com o resto, e
  **não** insiste nos lotes seguintes: um 429 é limite de taxa, e continuar
  pedindo só afunda. A causa vai para o console.
- **Cancelamento** → `ok: false, error: "cancelled"`, como antes. Checado em três
  pontos (antes de cada fala, depois de cada resposta, e antes de cada lote), e um
  `NetCancelled` vindo da rede também é desistência. Não vira `both-engines-failed`
  nem erro de tradução; `done`/`pending` acompanham só para diagnóstico. Deliberado:
  quem cancelou não pediu meio arquivo.
- **Timeout, 429, outro HTTP e erro de rede** seguem o mesmo caminho — parcial se
  houver progresso, falha total se não houver. Prazo não vira cancelamento e
  cancelamento não vira prazo. Nenhum retry novo.

**Ordem e integridade:** a reserva empilha em ordem e para na primeira falha, então
`texts[i]` é sempre a tradução de `lote[i]` — nenhuma escorrega para a fala
seguinte. A execução continua **serial**, de propósito.

**O parcial é dito, não escondido.** O chamador direto (`applyTranslate`) propaga
`pending`, e o painel acrescenta *"N trechos ficaram no idioma original (o tradutor
parou antes do fim)"* com tom de erro. Entregar meia tradução em silêncio seria
pior que a falha que isto substitui.

**Risco residual**

- **Um arquivo grande ainda pode terminar quase todo sem tradução** se o MyMemory
  limitar a taxa logo no começo: o parcial é honesto, mas não é uma tradução. Não
  há retry com espera, e não deveria haver sem uma política de backoff.
- **O cancelamento continua por booleano lido entre requisições.** Com o prazo do
  P2-8 a requisição em voo termina em no máximo 30 s, mas o `AbortSignal` não está
  ligado a este fluxo — seria reestruturar `TranslateOptions`, fora do escopo.
- **`pending` conta falas, e o painel conta blocos.** A frase diz "trechos" para
  não misturar as unidades, mas são medidas diferentes na mesma linha.
- **Nada foi executado no Premiere.** Falta traduzir um `.srt` real com o Google
  fora do ar para ver o parcial na tela.

## P3 — manutenção e limpeza

### P3-18 · Não existe lint, e o código já traz `eslint-disable` que nada aplica

- **Arquivos:** raiz do projeto; `src/shell/updater.ts:125` e `:301` têm comentários `// eslint-disable-next-line`
- **Causa:** `package.json` tem `typecheck`, `build`, `package`, `bench` e `test`,
  e nenhum `lint`. Não há `.eslintrc`, `eslint.config.*`, `biome.json` nem
  `oxlint` — e nenhum deles está em `devDependencies`.
- **Impacto:** as duas classes de defeito que mais aparecem nesta auditoria —
  promise flutuante sem tratamento (P1-3) e `await` dentro de laço quente
  (P2-11, P2-17) — são exatamente as que um lint pega de graça. Hoje o único
  guarda-corpo automático é o `tsc`, que não olha para isso.
- **Correção recomendada:** `typescript-eslint` mínimo com
  `no-floating-promises`, `no-misused-promises` e `require-await` ligados (exige
  `parserOptions.project`), ou `oxlint` se o tempo de execução importar. Rodar
  junto do `typecheck`.

### P3-19 · Código morto: 4 funções exportadas sem nenhum consumidor

- **Arquivos e regiões:**
  - `src/tools/captions/toAdobe.ts:186` — `toAdobeJSON()`
  - `src/tools/captions/srt.ts:461` — `toSrt()`
  - `src/tools/sfx/store.ts:196` — `copyUrl()`
  - `src/tools/titles/previews.ts` — `posterFor()`
- **Causa:** verificado por varredura de todos os símbolos exportados de `src/`
  contra `src/` e `test/`. Nenhuma dessas quatro é referenciada em lugar algum,
  nem por teste. O resto do projeto está notavelmente limpo — 4 de ~330 funções
  exportadas.
- **Impacto:** baixo. `toAdobeJSON` e `toSrt` são serializadores que parecem
  restos de caminhos substituídos, e um serializador morto ao lado de um vivo é
  convite a alguém corrigir o errado.
- **Correção recomendada:** remover, ou cobrir com teste se a intenção for
  mantê-las como API.

### P3-20 · Três implementações do mesmo `describe(cause)`

- **Arquivos:** `src/bridge/premiere.ts:25` (`describeError`), `src/tools/silence/workspace.ts:486` (`describe`), `src/tools/sfx/drive.ts:169` (`describe`, local)
- **Causa:** o corpo é idêntico nos três
  (`cause instanceof Error ? cause.message : String(cause)`). O próprio projeto
  já centralizou `escapeHtml` e `shellQuote` com o argumento explícito de que
  cópias são lugares onde uma correção não chega.
- **Impacto:** nenhum hoje; é inconsistência com uma regra que o projeto já
  adotou para código dessa natureza.
- **Correção recomendada:** manter uma só (a de `workspace.ts` é a mais
  importada) e reexportar.

### P3-21 · Dois recursos que o `beforeunload` promete soltar e não solta

- **Arquivo:** `src/shell/ProductShell.ts`
- **Região:** `constructor` (`segmentObserver` em ~204, `window.addEventListener("resize")` no fim), `start()` (`window.addEventListener("focus", …)`), bloco `beforeunload` (~305–320)
- **Causa:** o `beforeunload` remove o listener de `resize`, para o batimento do
  agente, limpa o `refreshTimer` e desmonta a Tool ativa. Ficam de fora o
  `MutationObserver` (`segmentObserver`) — nenhum `disconnect()` em todo o
  `src/`, verificado — e o listener de `focus`, que é o que dispara a releitura
  da timeline.
- **Impacto:** nenhum na prática, porque o descarregamento da página UXP leva os
  dois embora. Vale como consistência: o bloco existe para ser a lista completa
  do que sobrevive ao painel, e uma lista incompleta é pior que nenhuma.
- **Correção recomendada:** `this.segmentObserver?.disconnect()` e guardar a
  referência do handler de `focus` para removê-lo no mesmo bloco.

### P3-22 · As duas áreas com P0 são justamente as sem teste

- **Arquivos:** `test/` (19 arquivos, 315 testes)
- **Região:** cobertura por módulo
- **Causa:** os testes cobrem `bridge/destination`, `bridge/premiere`,
  `curves/easing`, `shell/dropdown`, `download/{history,instagram,ytdlp}`,
  `sfx/{pack,taxonomy}`, `soundDesign/*`, `titles/*` e `zoom/applyZoom`. Não
  cobrem `shell/updater.ts` nem `download/runner.ts` — e é lá que estão o P0-1 e
  o P1-6. Note que `runner.ts` exporta `agentBash()`, `agentVbs()` e
  `infoPlist()` como funções puras que devolvem texto, ou seja, foram feitas
  para serem testáveis, e nenhum teste as importa. `isNewerVersion` também é
  exportada e não tem teste próprio. Também sem cobertura: `applySilence`,
  `applyOrganize`, `applyFlow`, `captions/*`, `translate/engine`.
- **Impacto:** as correções de P0-1, P1-6 e P1-7 vão mexer em geração de script e
  em ordem de gravação — o tipo de mudança que quebra em silêncio e que só
  aparece na máquina do beta tester.
- **Correção recomendada:** antes de corrigir, teste de snapshot do texto de
  `agentBash()`/`agentVbs()` (fixa o laço, o lock e o carimbo), teste de
  `isNewerVersion` na tabela de casos, e um teste do filtro `fileEntries` do
  atualizador com entradas hostis (fecha P2-16 com prova).

---

# 3. Notas para as próximas etapas

**Agrupamentos naturais de correção** (cada grupo toca os mesmos arquivos, o que
reduz risco de regressão):

| Grupo | Itens | Arquivos |
|---|---|---|
| A — Entrega do plugin | P0-1, P1-4, P2-15, P2-16 | `shell/updater.ts`, `shell/ProductShell.ts` |
| B — Recuperação de operação destrutiva | P0-2, P2-9 | `silence/applySilence.ts`, `silence/silenceTool.ts`, `organize/*` |
| C — Erro visível no Apply | P1-3 | `shell/ProductShell.ts`, `organize/applyOrganize.ts` |
| D — Protocolo do agente | P1-5, P1-6, P1-7 | `download/runner.ts`, `sfx/native.ts`, `silence/ffmpeg.ts`, `translate/source.ts` |
| E — Rede com prazo | P2-8, P2-10, P2-13, P2-17 | `download/panelFetch.ts`, `sfx/drive.ts`, `translate/engine.ts`, `shell/updater.ts` |
| F — Custo de I/O no laço | P2-11, P2-12 | `download/ytdlp.ts`, `sfx/store.ts` |
| G — Higiene | P2-14, P3-18 a P3-22 | vários, isolados |

**O que esta auditoria não cobriu, e por quê:** nada foi executado dentro do
Premiere — a análise é estática. Três áreas que a memória do projeto marca como
não verificadas em host real continuam não verificadas aqui e pedem teste
manual, não leitura: `placeCuts` e `Level` do SFX Automático, a sonda de canais
mono/estéreo, e o agente no Windows (que o P1-6 sustenta em leitura do VBScript,
mas cuja confirmação exige a máquina).

**Ordem sugerida:** grupo C primeiro — é a correção mais barata do repositório e
é o que faz todas as outras falhas pararem de ser mudas, o que torna as etapas
seguintes depuráveis. Depois A e B (os P0), e só então D, que é o mais delicado
porque mexe em texto de script gerado.
