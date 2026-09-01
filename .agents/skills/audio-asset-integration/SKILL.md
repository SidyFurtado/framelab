---
name: audio-asset-integration
description: Patterns and rules for querying, indexing, and downloading audio assets from local libraries, open APIs, and enterprise providers like Artlist. Covers the SFX/music split, the local bank layout, and the provider adapter contracts.
---

# Audio Asset Integration

Use this skill when implementing asset resolvers, local audio indexing, API clients, or licensing verification for sound effects and music.

## 1. SFX e Trilha são Catálogos Separados (ADR-010)

Não existe um `AudioProvider` único. SFX e trilha divergem em tudo que a ferramenta usa:

| | SFX | Trilha |
| :--- | :--- | :--- |
| Quantidade por vídeo | dezenas | uma |
| Duração típica | 0,2–3s | 1–5min |
| Ponto de sincronismo | o transiente de ataque, no frame do corte | o downbeat / a estrutura |
| Faixa de destino | A3–A6 | A2 |
| O que a IA decide | **onde** colocar | **qual** escolher |
| Reuso do mesmo arquivo | normal | nunca |

Um tipo único deixaria metade dos campos nulos dos dois lados — `peakTransientOffsetSeconds` só existe para SFX, `bpm` e `sections` só para trilha.

## 2. Layout do Banco Local

A **categoria vem do caminho da pasta**, nunca de tagueamento manual. Isso elimina a inferência: o plugin não precisa descobrir se um arquivo é efeito ou trilha, ele já sabe.

```
audio/
  sfx/
    whoosh/  impact/  riser/  ui/  ambience/  foley/
  music/
    <mood>/          # tenso, up, melancólico, neutro…
  sfx_manifest.json
  music_manifest.json
```

O manifest carrega apenas o que a pasta não expressa: offset do transiente, BPM, tom, marcações de estrutura, tags e mood.

> [!IMPORTANT]
> **A heurística roda em sentido inverso.** Duração, nome de arquivo e contagem de canais separam SFX de trilha com boa margem, mas nunca são a fonte da verdade — a pasta é. Use-os apenas como checagem de sanidade na indexação: um arquivo de 4 minutos em `sfx/impact/` é reportado como provável erro de arquivamento, e **nunca** reclassificado em silêncio.

## 3. Provider Adapter Pattern

Uma mesma implementação (ex: `LocalFolderAudioProvider`) pode servir os dois papéis; o que não se mistura são as consultas e os tipos de asset.

```typescript
type SfxCategory = "whoosh" | "impact" | "riser" | "ui" | "ambience" | "foley";

/** O que os dois realmente compartilham. */
interface AudioAssetBase {
  id: string;
  name: string;
  durationSeconds: number;
  tags: string[];
  localFilePath?: string;
  previewUrl?: string;
}

/** Um hit curto, posicionado por frame. */
interface SfxAsset extends AudioAssetBase {
  kind: "sfx";
  /** Vem do caminho da pasta, não de metadado. */
  category: SfxCategory;
  /** O que se alinha ao frame do corte é o ataque, não o início do arquivo. */
  peakTransientOffsetSeconds: number;
}

/** Um leito longo, escolhido uma vez por vídeo. */
interface MusicAsset extends AudioAssetBase {
  kind: "music";
  mood: string;
  bpm?: number;
  musicalKey?: string;
  /** Onde a música muda de seção, para entrar e cortar no lugar certo. */
  sections?: Array<{
    label: "intro" | "build" | "drop" | "break" | "outro";
    atSeconds: number;
  }>;
  loop?: { inSeconds: number; outSeconds: number };
}

interface AudioResolver {
  /** Caminho local pronto para import no Premiere. */
  resolveLocalFile(asset: AudioAssetBase): Promise<string>;
}

interface SfxProvider extends AudioResolver {
  searchSfx(query: {
    category: SfxCategory;
    maxDuration?: number;
    tags?: string[];
  }): Promise<SfxAsset[]>;
}

interface MusicProvider extends AudioResolver {
  searchMusic(query: {
    mood?: string;
    /** A trilha precisa cobrir o vídeo inteiro. */
    minDuration: number;
    bpmRange?: [number, number];
  }): Promise<MusicAsset[]>;
}
```

## 4. Implementation Strategies

1. **LocalFolderAudioProvider (MVP / Offline)**:
   - Indexa `audio/sfx/` e `audio/music/` separadamente, derivando categoria e mood do caminho.
   - Lê metadados via ID3/WAV chunks ou dos manifests locais.
   - 100% confiável para desenvolvimento imediato, sem bloqueio comercial.
2. **OpenApiAudioProvider (Fallback)**:
   - Integra com a API do Freesound.org (OAuth2 / token) ou coleções CC0.
   - Serve bem o papel de SFX; para trilha, a curadoria costuma não bastar.
3. **ArtlistEnterpriseAudioProvider (Production Partner)**:
   - Autentica via OAuth 2.0 Client Credentials com Amazon Cognito.
   - Acessa endpoints da Artlist Enterprise API (`developer.artlist.io`).
   - Exige estritamente acordo de parceria Enterprise.

Trocar o provider de SFX não obriga a trocar o de trilha — é o ganho concreto da separação.

## 5. Compliance & Legal Guardrails

- **DO NOT** attempt web scraping or automated browser automation against consumer Artlist accounts (explicit ToS violation).
- **DO NOT** hardcode commercial API credentials in client-side extension code.

## 6. Reference Documentation

For API status tables and provider specifications, see [docs/TECHNICAL_BASELINE.md](file:///Users/sidyziin/Library/CloudStorage/GoogleDrive-sidycontato.f@gmail.com/Meu%20Drive/07_APPS%20E%20DEV/08_EDIT_PLUGIN/docs/TECHNICAL_BASELINE.md#2-artlist--estratégia-de-assets-de-áudio). For the decision behind the SFX/music split, see ADR-010 in [docs/DECISIONS.md](file:///Users/sidyziin/Library/CloudStorage/GoogleDrive-sidycontato.f@gmail.com/Meu%20Drive/07_APPS%20E%20DEV/08_EDIT_PLUGIN/docs/DECISIONS.md).
