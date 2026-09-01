# Questões em Aberto e Validações Futuras

Este documento mapeia pontos de validação técnica, divididos entre a **Plataforma (Product Shell)** e a **Primeira Ferramenta (`Tool: AI Sound Design`)**.

---

## 1. Plataforma & Product Shell
- **Mecanismo de Descoberta & Troca de Tools**: Qual o formato ideal de navegação (abas superiores de categorias + busca rápida ou barra lateral recolhível)?
- **Persistência de Estados Locais**: Estratégia de cache do UXP (`getDataFolder()`) para salvar histórico de ferramentas usadas e configurações por projeto.
- **BYOAI — Experiência de Conexão de Provider**: O Shell deve oferecer uma experiência simples de "Connect AI → Claude / OpenAI / Gemini" que esconda a complexidade de API keys e billing. Cada provider requer API key separada (não OAuth consumer). Como comunicar isso ao usuário de forma clara e não-técnica?
- **Storage Seguro de Credenciais**: Credenciais (API keys) pertencem ao usuário; jamais em plaintext. Investigar o mecanismo de secure storage disponível no UXP para persistência segura e revogação.
- **Compatibilidade de Capacidades**: Nem todos os providers suportam todas as capacidades (ex: Gemini tem video-understanding nativo; Claude e OpenAI não). Como o produto comunicará "Tool X funciona melhor com Provider Y" ou "Provider Z não suporta esta Tool"?

---

## 2. Estratégia de IA — Questões de Negócio
- **Fallback Opcional**: Devemos futuramente oferecer créditos/processamento próprio para usuários sem API key configurada? Modelos locais? Planos comerciais? — **Não decidido. Registrar para avaliação futura.**
- **Custos Transparentes**: Quando uma Tool disparar chamadas de IA usando a API key do usuário, o produto deve indicar claramente que haverá cobrança pelo provider externo. Nunca mascarar custos.
- **Consumer Subscription ≠ API Access**: Validar individualmente por provider se existe ou surgiu algum programa oficial que permita terceiros aproveitarem a assinatura consumer (historicamente, nenhum dos três permite).

---

## 3. Específico da Primeira Ferramenta (`Tool: AI Sound Design`)
- **Parceria Artlist Enterprise**: Contato com `enterprise-api-support@artlist.io` para validar disponibilidade de endpoints e contrato comercial para SFX.
- **Performance do Proxy de Vídeo**: Avaliar tempo de exportação de proxy leve 480p via `EncoderManager.exportSequence` versus exportação de áudio mixdown (.wav) + metadados de cortes.
- **Formato da Partitura de Revisão**: Testar se os editores preferem inserção direta com 1 clique ("Apply") ou visualização prévia da partitura de sugestões antes da escrita na timeline.
- **Banco de SFX do MVP**: Montar `audio/sfx/<categoria>/` com 200-500 efeitos para testes iniciais com o `LocalFolderAudioProvider`. A categoria sai do caminho da pasta (ADR-010), então **não há tagueamento manual** para o básico — o `sfx_manifest.json` carrega só o offset do transiente e as tags finas.
- **Trilha entra no MVP?** — **Não decidido.** O ADR-010 define a estrutura (`audio/music/<mood>/` e `MusicProvider`) mas não decide o escopo. Selecionar trilha é um problema diferente de posicionar SFX: envolve curadoria e direção, não sincronismo, e o valor da ferramenta pode estar inteiro nos efeitos. Avaliar se o MVP entrega só SFX e a trilha vem depois.
- **Marcações de estrutura da trilha**: Se a trilha entrar, `MusicAsset.sections` (intro/build/drop/outro) precisa vir de algum lugar — anotação manual, detecção de onset, ou metadado do fornecedor. Cada caminho tem custo bem diferente. Investigar antes de comprometer a interface.
- **Validação Multi-Provider para Sound Design**: Testar a qualidade de análise audiovisual com Gemini (nativo), e comparar com pipeline de frames extraídos via ffmpeg + Claude/OpenAI para determinar diferenças reais de qualidade.
