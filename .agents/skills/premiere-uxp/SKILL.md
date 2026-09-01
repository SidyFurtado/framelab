---
name: premiere-uxp
description: Guidelines and patterns for Adobe Premiere Pro UXP plugin development, DOM manipulation, SequenceEditor, audio track actions, and project import.
---

# Premiere Pro UXP Development

Use this skill when implementing, refactoring, or debugging code that interacts with the Adobe Premiere Pro UXP DOM and host application.

## 1. Core Architecture & Requirements
- **Host Module**: `const app = require('premierepro');`
- **UXP Storage**: `const { localFileSystem } = require('uxp').storage;`
- **Minimum Target**: Premiere Pro v24.2+ (Recommended: v25.0+ / v25.6+).
- **Manifest**: Must use `manifestVersion: 5`. Declare em `requiredPermissions` **apenas** o que a ferramenta usa — `localFileSystem: "fullAccess"` e `network: { domains: "all" }` só quando houver leitura de disco ou chamada de rede. Ferramentas puramente de timeline (Zoom, Curvas) rodam com `requiredPermissions: {}`; pedir permissão à toa é atrito para o usuário na instalação.

## 2. Sequence Manipulation & Transactions
Never manipulate the timeline via unmanaged synchronous loops. All timeline changes in UXP must go through `SequenceEditor` and atomic transactions:

```javascript
const project = await app.Project.getActiveProject();
const sequence = await project.getActiveSequence();
const editor = SequenceEditor.getEditor(sequence);

// Exemplo: Inserir item de áudio na track de SFX
const insertAction = editor.createInsertProjectItemAction(
  projectItem,       // ProjectItem importado
  startTimeTick,     // Posição no tempo (Ticks ou Time object)
  targetAudioTrack,  // Índice da faixa de áudio (ex: 2 para SFX_WHOOSH)
  -1                 // -1 para ignorar faixas de vídeo
);

await project.executeTransaction((transaction) => {
  transaction.addAction(insertAction);
}, "Inserir Efeitos Sonoros AI");
```

## 3. Media Import & Bin Organization
Always import SFX into a dedicated, organized bin to keep the editor's project clean:
```javascript
// Importa lista de caminhos absolutos para uma bin alvo
await project.importFiles(
  filePathsArray, 
  true,        // suppressUI
  sfxBinItem,  // ProjectItem do tipo Bin
  false        // asNumberedStills
);
```

## 4. Track Management Best Practices
- Verify available tracks using `sequence.getAudioTrackCount()`.
- If inserting into an index beyond existing tracks, the UXP engine automatically creates a new track.
- Label and group SFX by category on separate tracks (`A1`: Diálogo, `A2`: Música, `A3`: `SFX_WHOOSH`, `A4`: `SFX_IMPACTS`, `A5`: `SFX_AMBIENCE`, `A6`: `SFX_UI`).

## 5. Reference Documentation
For complete DOM specifics and export options, refer to [docs/TECHNICAL_BASELINE.md](file:///Users/sidyziin/Library/CloudStorage/GoogleDrive-sidycontato.f@gmail.com/Meu%20Drive/07_APPS%20E%20DEV/08_EDIT_PLUGIN/docs/TECHNICAL_BASELINE.md#1-adobe-premiere-pro-uxp) and [docs/SOURCES.md](file:///Users/sidyziin/Library/CloudStorage/GoogleDrive-sidycontato.f@gmail.com/Meu%20Drive/07_APPS%20E%20DEV/08_EDIT_PLUGIN/docs/SOURCES.md#1-adobe-premiere-pro--uxp).
