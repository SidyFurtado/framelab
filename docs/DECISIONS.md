# Registro de Decisões de Arquitetura (ADRs)

Este documento registra as decisões estruturais da plataforma e das ferramentas individuais.

---

## PARTE I — DECISÕES DA PLATAFORMA (PRODUCT SHELL)

### ADR-001: Plataforma UXP-First Exclusiva
- **Status**: Decidido
- **Contexto**: A Adobe consolidou o UXP como ambiente padrão para Premiere Pro (v24.2+ / v25.0+).
- **Decisão**: Desenvolver a plataforma exclusivamente em **UXP (Manifest v5)**.
- **Consequência**: Execução nativa rápida em JavaScript V8 assíncrono, suporte a transações atômicas e longevidade de código.

### ADR-002: Pure JS UXP no Core da Plataforma
- **Status**: Decidido
- **Contexto**: C++ / UXP Hybrid adiciona complexidade desnecessária de compilação multiplataforma.
- **Decisão**: Manter o Product Shell e ferramentas em **Pure JS UXP**.
- **Consequência**: Arquitetura ágil, limpa e manutenível.

### ADR-003: Arquitetura Product Shell + Tool Registry
- **Status**: Decidido
- **Contexto**: O plugin é uma toolbox expansível que receberá múltiplas ferramentas ao longo do tempo.
- **Decisão**: Desacoplar a infraestrutura permanente (`ProductShell`) do catálogo de ferramentas (`ToolRegistry`).
- **Consequência**: Novas ferramentas são adicionadas modularmente sem impactar as demais ou a navegação global.

### ADR-004: Modelo de UX Tool Launcher + Active Tool Workspace
- **Status**: Decidido
- **Contexto**: Editores precisam de velocidade e baixo atrito sem poluição de interface.
- **Decisão**: Adotar a experiência de catálogo de ferramentas rápido + painel focado na ferramenta ativa.
- **Consequência**: Fluxo *"Achar ferramenta → Executar tarefa → Voltar para a edição"*.

### ADR-005: Bring Your Own AI (BYOAI) — Provider-Agnostic
- **Status**: Decidido
- **Contexto**: O produto não deve depender de um único provedor de IA proprietário. Editores de vídeo podem ter preferências e assinaturas diferentes.
- **Decisão**: Adotar uma arquitetura **Bring Your Own AI** onde o usuário conecta seu próprio provedor (Claude, OpenAI ou Gemini) via API key. Tools declaram capacidades necessárias (ex: `video-understanding`, `structured-output`); a camada `AIProviderLayer` roteia para o adapter conectado.
- **Consequência**: Flexibilidade do usuário, sem lock-in a um único fornecedor, e capacidade de escalar para novos modelos no futuro.
- **Nota Crítica**: Consumer subscription (Claude Pro, ChatGPT Plus, Google AI Pro) **NÃO** é equivalente a API access. Todos os três provedores exigem contas/API keys separadas. Validar individualmente.

---

## PARTE II — DECISÕES ESPECÍFICAS DA PRIMEIRA FERRAMENTA (`Tool: AI Sound Design`)

### ADR-006: Gemini como Candidato Recomendado para Análise Audiovisual
- **Status**: Recomendado (pendente validação com testes reais)
- **Contexto**: A ferramenta de Sound Design requer análise simultânea de imagem, áudio e timestamps. Gemini é o único dos três provedores com ingestão nativa de containers de vídeo via File API.
- **Decisão**: Recomendar Google Gemini (2.0 Flash / 1.5 Flash) como **primeiro candidato** para a `Tool: AI Sound Design`, sem acoplar a plataforma a ele.
- **Consequência**: Testes iniciais com Gemini. Se OpenAI ou Claude lançarem suporte nativo a vídeo, o adapter correspondente poderá ser adicionado sem refatoração.

### ADR-007: Padrão `AudioProvider` para Catálogo de SFX
- **Status**: Decidido (Escopo da Tool)
- **Contexto**: Acesso à API do Artlist requer contrato Enterprise B2B.
- **Decisão**: Encapsular a busca de áudio na interface `AudioProvider`, iniciando no MVP com banco local indexado (`LocalFolderAudioProvider`).
- **Consequência**: Desenvolvimento e testes 100% autônomos sem bloqueio comercial.

### ADR-008: Sincronismo Frame-Perfect Híbrido
- **Status**: Decidido (Escopo da Tool)
- **Contexto**: Amostragem de vídeo a 1 FPS na IA pode perder micro-eventos rápidos de poucos frames.
- **Decisão**: Injetar os pontos exatos de corte da timeline do Premiere como metadados no prompt da IA.
- **Consequência**: Alinhamento cirúrgico de transientes de SFX nos frames exatos dos cortes.

### ADR-009: Inserção Atômica em Faixas de Áudio Dedicadas
- **Status**: Decidido (Escopo da Tool)
- **Contexto**: O editor necessita de organização não-destrutiva e Undo imediato.
- **Decisão**: Inserir SFX em faixas nomeadas (`SFX_WHOOSH`, `SFX_IMPACT`, etc.) via `project.executeTransaction()`.
- **Consequência**: Preservação de faixas de voz/música e suporte nativo a Undo no Premiere.

### ADR-010: SFX e Trilha são Catálogos Separados, com a Pasta como Fonte da Categoria
- **Status**: Decidido
- **Contexto**: Um banco único de áudio obrigaria o plugin a inferir, por análise, se um arquivo é um efeito pontual ou um leito musical. A inferência é desnecessária: a estrutura de pastas já carrega essa informação de forma exata e gratuita. Mais importante, os dois não são o mesmo tipo de asset com categorias diferentes — divergem em quantidade por vídeo (dezenas contra uma), duração (0,2–3s contra 1–5min), ponto de sincronismo (o transiente de ataque alinhado ao frame do corte contra o downbeat e a estrutura), faixa de destino (A3–A6 contra A2) e no que a IA precisa decidir (**onde** colocar contra **qual** escolher). A interface `AudioAsset` original evidencia o conflito: `peakTransientOffsetSeconds` é um conceito exclusivo de SFX, enquanto trilha precisa de BPM, tom, marcações de estrutura e pontos de loop.
- **Decisão**: Separar o banco local em `audio/sfx/<categoria>/` e `audio/music/<mood>/`, com manifests independentes. A **categoria vem do caminho da pasta**, não de tagueamento manual. Modelar dois papéis de provider — `SfxProvider` e `MusicProvider` — que podem ser servidos pela mesma implementação (`LocalFolderAudioProvider`), mas com consultas, tipos de asset e destinos de faixa distintos.
- **Consequência**: Nenhum campo nulo por construção; indexação sem heurística; a divisão de faixas do ADR-009 passa a existir também na camada de dados, e não só na inserção. Trocar o provider de SFX (para Freesound ou Artlist) não obriga a trocar o de música.
- **Nota sobre heurística**: Duração, nome de arquivo e contagem de canais separam SFX de trilha com boa margem, mas essa heurística é usada em sentido **inverso** — a pasta manda, e a duração serve de checagem de sanidade na indexação. Um arquivo de 4 minutos em `sfx/impact/` é avisado como provável erro de arquivamento, nunca reclassificado em silêncio.

---

## PARTE III — DECISÕES DA FERRAMENTA `Corte de Silêncios`

### ADR-011: Detecção de Silêncio pela Transcrição do Premiere, não por Nível de Áudio
- **Status**: Substituída como padrão pela ADR-015; mantida como modo alternativo
- **Contexto**: O UXP não expõe samples de áudio — não há Web Audio, não há decodificador, não é possível executar binário externo (ffmpeg), e o único arquivo alcançável via `fs` é o original comprimido. Um detector de limiar em dB, que é o padrão da categoria, está fora de alcance dentro do host.
- **Decisão**: Usar `Transcript.exportToJSON(clipProjectItem)` como fonte de fala, lendo o schema público da Adobe (`schemas.adobe.com/transcript/v1.0.0`) com tempo palavra a palavra. O parser aceita também o formato antigo `monologues[].elements[]`.
- **Consequência**: O corte **nunca** cai no meio de uma palavra — o que um limiar em dB não garante, já que sílaba fraca fica abaixo do limiar e respiração/teclado ficam acima. A marcação `tags: ["filler"]` entrega a remoção de muletas sem custo adicional. Em troca, a ferramenta depende de o clipe estar transcrito (*Texto* › *Transcrever*, gratuito e offline); clipes sem transcrição são listados com o motivo e não são tocados.
- **Nota**: A camada de detecção recebe intervalos de fala genéricos (`VoicedSpan[]`), não a transcrição. Uma segunda fonte (análise de PCM em WAV/AIFF, ou um provider de IA) pode ser acrescentada sem tocar no algoritmo nem na execução.

### ADR-014: Controle de Ruído por Confiança e Ilhamento, no Lugar do Limiar em dB
- **Status**: Decidido
- **Contexto**: A expectativa natural de quem edita é um slider de dB — é o controle padrão da categoria (AutoCut, Silence Killer). Sem acesso a samples (ADR-011), esse slider seria um controle que não lê nada. Mas o problema que ele resolve é real e se divide em dois: ruído contínuo e ruído reconhecido como fala.
- **Decisão**: Não expor limiar em dB. Ruído contínuo (ar-condicionado, chiado, hum) é resolvido por construção — não vira palavra, logo já é silêncio. Para o ruído que o transcritor ouve como fala, expor dois controles sobre dados reais: **confiança mínima** (`word.confidence`) e **duração máxima de som solto**. Ambos só descartam som **isolado** — sem outra fala perto dos dois lados, contando a borda do clipe como lado vazio.
- **Consequência**: Nenhum ajuste de ruído pode abrir corte no meio de uma frase, porque palavra com vizinha nunca é candidata — a propriedade que um limiar em dB não consegue oferecer. O ruído é avaliado **antes** da remoção de muletas: fazer o contrário isolaria artificialmente as vizinhas do "né" removido e as descartaria como estalo. Quando a transcrição não traz confiança por palavra, a interface diz isso em vez de deixar o slider fingir que funciona.

### ADR-012: Corte por Reconstrução (`setInOutPoints` + `overwrite`), na Ausência de API de Razor
- **Status**: Decidido
- **Contexto**: Não existe API de split/razor no UXP. A Adobe declarou no fórum oficial de desenvolvedores que nenhuma está planejada para o 1.0, que prioriza paridade com CEP+ExtendScript (sem QE DOM). `SequenceEditor` não expõe nada que parta um track item em dois.
- **Decisão**: Emular o corte removendo o track item original e reescrevendo, por cima, N instâncias do mesmo `ClipProjectItem` — cada uma com `createSetInOutPointsAction` do trecho que sobrevive, posicionada por `createOverwriteItemAction`. Uma transação por trecho, porque ações dentro de uma mesma transação não observam os efeitos umas das outras: o in/out precisa estar aplicado antes do overwrite que o consome.
- **Consequência**: Para o editor o resultado é indistinguível de ter passado a lâmina. O preço, declarado na interface: efeitos e keyframes daquele track item não sobrevivem (o item novo nasce limpo), e o undo do Premiere ganha um passo por trecho. A ferramenta compensa o segundo ponto guardando o estado anterior e oferecendo o próprio "Desfazer corte", que devolve cada clipe original inteiro.
- **Revisão**: Quando a Adobe publicar uma ação de split, a troca fica contida em `applySilence.ts` — detecção, algoritmo e interface não mudam.

### ADR-013: Compactação por Run, sem Ripple Global
- **Status**: Decidido
- **Contexto**: Fechar os buracos exigiria mover tudo que vem depois, em todas as faixas. `createRemoveItemsAction` aceita `ripple`, mas a semântica exata em faixas paralelas não é documentada, e errar isso desloca b-roll e trilha em silêncio.
- **Decisão**: Compactar apenas dentro de *runs* — sequências de clipes selecionados que se encostam na mesma dupla de faixas. O tempo removido vira um espaço único no fim de cada run.
- **Consequência**: A operação é fechada e previsível: nada fora da região selecionada se move. Fechar o espaço final é um Shift+Delete do editor, e é reversível. Clipes separados por um buraco não entram na mesma run, então a compactação nunca invade o que estiver no meio.

### ADR-015: Onda via ffmpeg como Detecção Padrão, Executado por `shell.openPath`
- **Status**: Decidido
- **Contexto**: A transcrição (ADR-011) nunca corta no meio de palavra, mas herda os erros do reconhecimento e depende de o clipe estar transcrito — que é exatamente a experiência que o Text-Based Editing do próprio Premiere já entrega, e que na prática sai irregular. O corte que um editor espera de uma ferramenta de silêncio é o corte pelo nível real do áudio.
- **Contexto técnico**: O UXP não tem `child_process`, mas tem `shell.openPath`, documentado pela Adobe para lançar processos — e um script executável é "aberto" sendo executado. As limitações declaradas (não passar argumentos, não capturar saída) não pesam quando o script é **gerado** pelo plugin: os argumentos já vão escritos dentro dele, e o resultado volta por arquivo.
- **Decisão**: Tornar **Onda (ffmpeg)** o modo padrão. O plugin escreve um `.command` (modo `0o755`), dispara com `shell.openPath`, e o script extrai PCM cru (mono, 8 kHz, 16 bits, high-pass 85 Hz) por arquivo de mídia, reportando por `progress.txt` e `result.json` (escrito em `.tmp` + `mv`). O plugin transforma o PCM numa curva de RMS por janela de 20 ms e **guarda só a curva**. Manter transcrição como segundo modo, selecionável e persistido.
- **Consequência**: O limiar vira um controle real — e no automático ele é `piso de ruído medido + margem`, calibrado por clipe, que é a resposta correta para "às vezes o silêncio tem ruído". Guardar a curva em vez dos samples faz o slider de dB recalcular o plano inteiro em memória, sem reexecutar o ffmpeg. O custo: uma dependência externa (ffmpeg instalado), duas permissões novas no manifest (`localFileSystem: fullAccess` e `launchProcess`), um diálogo de consentimento do sistema e uma janela de Terminal visível durante a extração. Uma execução por varredura, nunca por clipe, porque cada `openPath` é um diálogo.
- **Verificado fora do host**: análise contra PCM real gerado pelo ffmpeg (piso, limiar, bordas dos blocos de fala) e o script gerado executado de verdade, com caminho contendo espaço, acento e apóstrofo, confirmando que o `-ss` do ffmpeg casa com a base de tempo do envelope.

### ADR-016: Endereçamento de Arquivo Descoberto em Tempo de Execução, não Declarado
- **Status**: Decidido
- **Contexto**: O `fs` do UXP roteia por esquema (`plugin:`, `plugin-data:`, `plugin-temp:`, `file:`). O UXP do Premiere **não atende a rota `file:`**: escrever em caminho nativo devolve `Route not found`, mensagem que não menciona permissão nem caminho e que, sem contexto, parecia falha de carregamento do painel. Ao mesmo tempo, `shell.openPath` e o ffmpeg só entendem caminho nativo.
- **Decisão**: Isolar o problema em `workspace.ts`, que mantém os dois endereços da mesma pasta (o do `fs` e o nativo) e **descobre** qual combinação funciona em vez de declará-la por versão de host: testa `plugin-data:` com subpasta, `plugin-data:` na raiz, `plugin-temp:` e caminho nativo, escrevendo um arquivo de teste e lendo de volta em cada candidato. Também testa `writeFileSync` e, se falhar, `writeFile`.
- **Consequência**: A ferramenta funciona em builds com suporte parcial de FSAPI, e continuará funcionando se a Adobe passar a atender `file:` — a rota nova simplesmente vence o teste. Ler de volta (e não só escrever) é o que impede um candidato que engole o arquivo de ser eleito. Toda ponte com o host passa por um `step()` que etiqueta a falha com o nome da chamada, e um botão de diagnóstico exercita a corrente inteira até executar um script de teste, para que a próxima falha desse tipo se identifique sozinha em vez de custar horas.
