# Specification: Tool — Corte de Silêncios

Categoria: **Edição** · id `silence` · glyph `cut`

---

## 1. Visão Geral

Remove as pausas de um take falado e encosta os trechos que sobram, com quatro presets
que vão do jump cut de YouTube ao corte suave de aula. A detecção padrão mede a **onda**
do áudio via ffmpeg; a alternativa usa a transcrição do Premiere. Todos os parâmetros
continuam ajustáveis à mão, e o plano é recalculado em tempo real antes de qualquer
escrita na timeline.

---

## 2. User Flow

1. O editor seleciona um ou mais clipes falados na timeline (vídeo, áudio ou o par linkado).
2. Escolhe o modo de detecção e um preset — ou ajusta os sliders.
3. Clica em **Analisar seleção**. No modo Onda o plugin extrai o áudio com o ffmpeg
   (o sistema pede autorização na primeira vez) e mede a curva de dB.
4. O painel mostra os números (cortes, tempo removido, duração final), uma barra por clipe
   com o que fica e o que sai, e — no modo Onda — o piso de ruído, o nível de fala e o
   limiar aplicado em cada clipe.
5. Mexer em qualquer parâmetro, **inclusive o limiar**, recalcula tudo em memória: a curva
   já está lá, o ffmpeg não roda de novo.
6. **Cortar silêncios** aplica. **Desfazer corte** devolve os clipes originais inteiros.

---

## 3. Detecção — dois modos

### 3.1 Onda (padrão)

O ffmpeg extrai o áudio do arquivo original em PCM cru — mono, 8 kHz, 16 bits, com
high-pass em 85 Hz — e o plugin calcula o RMS em janelas de 20 ms, virando uma curva em
dBFS. É essa curva que responde "aqui tem som?".

As escolhas de formato não são arbitrárias:

- **8 kHz**: a energia da fala vive abaixo de 4 kHz, que é exatamente o que essa taxa
  carrega. Dez minutos de áudio viram 30 mil floats.
- **High-pass em 85 Hz**: ronco de ar-condicionado e trepidação de mesa sobem o RMS sem
  ser som audível. Sem o filtro, o piso de ruído sai inflado por grave que ninguém ouve.
- **Guardar a curva, não os samples**: é o que permite o limiar ser um slider de verdade.

> **Nota de leitura**: como a cadeia mede em banda de fala, chiado de banda larga lê alguns
> dB abaixo do que o medidor do Premiere mostra (a reamostragem 48k→8k descarta 5/6 da
> banda, ou seja −7,8 dB de ruído branco). Isso não afeta o limiar **automático**, que é
> relativo ao piso medido; afeta só quem digita um número absoluto no limiar fixo.

### 3.2 Transcrição (alternativa)

Usa `Transcript.exportToJSON` — schema público da Adobe (`schemas.adobe.com/transcript/v1.0.0`),
`segments[].words[]` com `start`, `duration`, `confidence` e `tags`. O parser também aceita
o formato antigo `monologues[].elements[]` (`ts` / `end_ts`) e tolera tempo relativo ao segmento.

| | Onda | Transcrição |
| :--- | :--- | :--- |
| Precisa de ffmpeg | sim | não |
| Precisa de transcrição | não | sim |
| Corte no meio de palavra | possível | impossível por construção |
| Remove muletas ("né", "tipo") | não | sim (`tags: ["filler"]`) |
| Limiar em dB | sim | não existe |

Os dois modos entregam a mesma coisa ao planejador — uma lista de `VoicedSpan` — e daí para
frente o caminho é idêntico.

---

## 4. Como um plugin UXP roda o ffmpeg

O UXP não tem `child_process`. O que ele tem, documentado pela Adobe, é
`shell.openPath(caminho)`, que abre um arquivo com o aplicativo padrão do sistema — e um
script executável é "aberto" sendo executado. As duas limitações da API são que não dá para
passar argumentos nem capturar a saída, e nenhuma pesa aqui: **o script é gerado por nós**,
então os argumentos já vão escritos dentro dele, e o resultado volta por arquivo.

O ciclo:

1. O plugin escreve `extract.command` (modo `0o755`) na pasta de dados do plugin — via
   esquema `plugin-data:`, ver 4.1.
2. `shell.openPath` executa. O sistema pede consentimento — uma vez, com opção de lembrar.
3. O script procura o ffmpeg (caminho configurado → `/opt/homebrew` → `/usr/local` →
   `/opt/local` → `/usr/bin` → `PATH`), roda um `ffmpeg` por arquivo de mídia e escreve
   `progress.txt` a cada job.
4. No fim escreve `result.json` — em `.tmp` e depois `mv`, senão o painel leria um JSON
   pela metade e chamaria de falha uma extração que deu certo.
5. O painel faz polling desses dois arquivos a cada 350 ms.

**Uma execução por varredura**, nunca uma por clipe: cada `openPath` é um diálogo de
consentimento. Dez clipes do mesmo bruto viram um job só, cobrindo a união dos trechos
usados, e o resultado fica em cache por sessão.

**Permissões no manifest**: `localFileSystem: "fullAccess"` (escrever o script, ler o PCM) e
`launchProcess: { schemes: [], extensions: [".command", ".bat"] }`.

> **Cuidado**: em `launchProcess` os DOIS campos são obrigatórios. A documentação da Adobe
> nunca mostra array vazio, então o valor usado aqui é `schemes: ["file"]`.

### 4.1 Dois endereços para a mesma pasta

O `fs` do UXP não endereça arquivos por caminho e pronto: ele **roteia por esquema** —
`plugin:`, `plugin-data:`, `plugin-temp:` e `file:`. Caminho sem esquema é tratado como
`file:`, e **o UXP do Premiere não atende essa rota**: qualquer escrita em caminho nativo
volta com `Route not found` — mensagem que não fala de permissão nem de caminho.

Mas `shell.openPath` e o ffmpeg são o mundo de fora e precisam do caminho **nativo**. Logo
cada arquivo tem dois endereços, e `workspace.ts` mantém os dois juntos:

| Quem lê/escreve | Endereço |
| :--- | :--- |
| `fs` do UXP (script, config, PCM de volta) | `plugin-data:/edit-toolbox-audio/…` |
| `shell.openPath` e o ffmpeg | `/Users/…/PluginData/edit-toolbox-audio/…` |

Nada disso é declarado por versão de host: é **descoberto**. Na primeira escrita o módulo
testa os candidatos em ordem — `plugin-data:` com subpasta, `plugin-data:` na raiz,
`plugin-temp:`, e por fim caminho nativo — escrevendo um arquivo de teste e **lendo de
volta** em cada um. Fica com o primeiro que responder, e o diagnóstico mostra qual venceu.
Assim uma build que passe a atender `file:` (ou que deixe de atender `plugin-data:`) não
quebra nada.

---

## 5. Ruído

O problema tem dois lados, e os modos os resolvem de formas diferentes.

**Ruído contínuo** (ar-condicionado, chiado, hum): no modo Onda é o que o **limiar
automático** resolve — ele mede o piso de ruído de cada clipe e soma a margem, então um take
barulhento se calibra sozinho em vez de exigir um número absoluto que muda a cada gravação.
No modo Transcrição já é resolvido por construção: ruído não vira palavra.

**Ruído que passa por som** (estalo, tosse, batida de mesa, um "ah" fantasma):

| Controle | Modo | O que descarta |
| :--- | :--- | :--- |
| **Margem sobre o ruído** (dB) | Onda | Tudo abaixo de `piso medido + margem` |
| **Limiar fixo** (dBFS) | Onda | Tudo abaixo do valor absoluto |
| **Rejeitar ruído abaixo de** (%) | Transcrição | Som isolado com `confidence` menor que o valor |
| **Som solto até** (s) | ambos | Som isolado mais curto que o valor |

**A garantia**: as regras de "som solto" e de confiança só olham para som **isolado** — sem
outra fala perto dos dois lados (a borda do clipe conta como lado vazio). Som dentro de uma
frase nunca é candidato, por mais agressivo que seja o ajuste.

**Teto do limiar automático**: nenhuma margem consegue colocar o limiar acima do nível da
própria voz (`min(piso + margem, max(piso + 3, fala − 10))`). Sem essa rede, uma margem alta
num clipe de fala baixa apagaria o clipe inteiro.

**A ordem importa**: o ruído é medido na fala *completa*, com as muletas ainda presentes.
Tirar a muleta antes abriria buracos em volta das vizinhas, e uma palavra curta que só ficou
sozinha porque o "né" ao lado sumiu seria descartada como estalo.

---

## 6. Algoritmo (`detect.ts` — puro, sem host)

Entra a lista de intervalos de som, o trecho do source que está na timeline e os parâmetros;
sai o que fica e o que sai, em segundos de source.

1. Recorta ao trecho que está na timeline.
2. Descarta o ruído isolado (ver seção 5), medido na fala completa.
3. Descarta as muletas, se pedidas (modo Transcrição).
4. Funde blocos separados por menos que **Silêncio mínimo**. O parâmetro é medido na fala
   crua, antes das margens: é a pergunta "houve pausa?", não "quanto sobrou depois da margem".
5. Devolve **Margem antes** / **Margem depois** em volta de cada bloco e refunde o que colidiu.
6. Cresce qualquer trecho menor que **Trecho mínimo** em volta do próprio centro.
7. Alinha ao grid de frames, sempre para fora (arredondar para dentro come sílaba).
8. O complemento vira corte. Cortes menores que 2 frames voltam a ser material: um soluço de
   um frame não é corte, só picota a timeline.

No modo Onda, a conversão curva → intervalos usa **histerese de 2 dB** (entra na fala ao
cruzar o limiar, só sai 2 dB abaixo). Sem isso, uma sílaba oscilando em volta do limiar
viraria dezenas de intervalos picados.

---

## 7. Presets

| Preset | Silêncio mín. | Margem antes | Margem depois | Trecho mín. | Margem s/ ruído | Som solto até | Muletas | Confiança |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | :--- | ---: |
| **YouTube** | 0,15s | 0,02s | 0,04s | 0,10s | +12 dB | 0,25s | remove | 40% |
| **Dinâmico** | 0,30s | 0,05s | 0,08s | 0,15s | +10 dB | 0,20s | mantém | 30% |
| **Natural** | 0,60s | 0,10s | 0,15s | 0,25s | +8 dB | 0,12s | mantém | 20% |
| **Aula** | 1,20s | 0,20s | 0,25s | 0,40s | +6 dB | — | mantém | — |

Num take sintético de 120s com 248 palavras, a escala rende 40% / 35% / 30% / 25% de tempo
removido — a diferença entre os presets é audível, não decorativa.

---

## 8. Execução — o razor que não existe

Não há API de split no UXP; a Adobe confirmou no fórum de desenvolvedores que nenhuma está
planejada para o 1.0. O corte é feito por **reconstrução**:

1. Remove o track item original (sem ripple — o resto da timeline não pode se mexer).
2. Para cada trecho mantido: `ClipProjectItem.createSetInOutPointsAction(in, out)` seguido de
   `SequenceEditor.createOverwriteItemAction(projectItem, posição, vTrack, aTrack)`.

O in/out precisa estar no item de projeto **antes** do overwrite que o consome — ações dentro
de uma mesma transação não observam os efeitos umas das outras. Por isso cada trecho vai numa
transação própria, carregando o overwrite do trecho anterior e preparando o in/out do próximo.

**Compactação**: clipes selecionados que se encostam na mesma dupla de faixas formam uma
*run*, e os trechos mantidos são empurrados para a esquerda até encostar dentro dela. O tempo
removido vira um espaço único no fim da run — fechá-lo é um Shift+Delete do editor. Clipes
separados por um buraco não entram na mesma run: puxar um para o outro invadiria o que
estiver no meio.

### 8.1 Handles morrem a cada transação

O UXP do Premiere invalida os objetos de script criados **antes** de uma transação: usar um
deles depois devolve `The script object is no longer valid`. Como o corte roda `1 + N`
transações por *run*, quase todo handle lido no começo já está morto no meio do caminho.

Três regras, e a execução inteira sai delas:

1. **Nada de handle guardado.** O plano carrega o **id** do item de projeto (`getId()`), não o
   objeto. Cada transação resolve o handle na hora, contra um mapa da bin relido pelo host.
2. **Track item se reencontra pela posição.** Antes de remover uma *run*, os itens são
   relidos da timeline por `startTicks`/`endTicks` — a posição sobrevive ao que o handle não
   sobrevive.
3. **A seleção vive dentro do callback.** O objeto que `createEmptySelection` entrega vale no
   escopo do callback, então a transação de remoção roda lá dentro. (Há um caminho de reserva
   com a transação fora do escopo, para builds que recusem o aninhamento.)

Além disso: o `build` de `executeTransaction` é **síncrono** por exigência da Adobe — um
`await` lá dentro invalida os objetos no meio da transação —, a exceção é capturada **dentro**
do `lockedAccess` (deixá-la atravessar o lock deixava o projeto travado, e daí toda transação
seguinte falhava junto), e uma transação que cai é refeita **uma vez** com o host reaberto.

### 8.2 Limites, ditos na interface

- **Efeitos do track item não sobrevivem.** O item novo nasce limpo. A ferramenta corta antes
  do tratamento — que é a ordem natural do trabalho.
- **Velocidade alterada é recusada.** Com speed ≠ 1 um segundo de source deixa de valer um
  segundo de sequência e cada tick cairia no lugar errado.
- **Undo**: cada trecho empilha um passo no undo do Premiere, então a ferramenta guarda o
  estado anterior e oferece o próprio **Desfazer corte**, que devolve cada clipe original
  inteiro numa passada só.
- **Outras faixas não se mexem.** B-roll e trilha em faixas paralelas continuam onde estavam.
- **Áudio linkado fora da seleção** dispara aviso em vez de dessincronizar calado.

---

## 9. O que foi verificado fora do Premiere

| Suíte | O que prova |
| :--- | :--- |
| `test.mjs` | Invariantes do algoritmo em take sintético: `keep ∪ drop` fecha o trecho sem sobreposição, `kept + removed = total`, nada abaixo de 1 frame, nenhum corte abaixo de 2 frames, nenhuma palavra perdida, escala de agressividade monotônica entre presets |
| `noise.mjs` | Filtro de ruído: fantasma isolado é descartado, palavra fraca **dentro** de frase sobrevive ao filtro no máximo, ruído na borda do clipe é pego, clipe só com ruído não é apagado |
| `wave.mjs` | Análise contra PCM **real** gerado pelo ffmpeg: piso e nível medidos batem com o sinal construído, limiar automático cai entre ruído e fala, margem absurda não passa da voz, os 6 blocos de fala saem com bordas exatas, o estalo aparece como som isolado |
| `script.mjs` | Script gerado e **executado** de verdade: caminho com espaço, acento e apóstrofo, protocolo `progress.txt`/`result.json`, e o `-ss` do ffmpeg casando com a base de tempo do envelope (fala em 20,00s ± 0,1) |

O que **não** foi verificado: tudo que exige o host — `shell.openPath` disparando o script
dentro do Premiere, o diálogo de consentimento, e a reconstrução da timeline.

---

## 10. Arquivos

| Arquivo | Papel |
| :--- | :--- |
| `presets.ts` | Presets, limites e especificação dos sliders |
| `detect.ts` | O algoritmo. Puro, sem host |
| `waveform.ts` | PCM → curva de dB → piso de ruído → limiar → intervalos |
| `ffmpeg.ts` | Geração do script, execução via `shell.openPath`, polling e leitura do PCM |
| `transcript.ts` | Leitura e parse da transcrição do Premiere |
| `applySilence.ts` | Varredura da seleção, execução e desfazer |
| `silenceTool.ts` | Workspace |
