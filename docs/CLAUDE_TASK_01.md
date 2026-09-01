# Task 01: Minimum UXP Plugin Bootstrap

## Goal
Scaffold and validate the minimum runnable UXP plugin for Adobe Premiere Pro, containing a functional Product Shell graybox, a placeholder for the Zoom Tool, and a verified read-only call to the Premiere Pro DOM.

## Read Only These Files
- `.agents/rules/project_guidelines.md`
- `docs/PRODUCT.md`
- `docs/DECISIONS.md`

## Create/Edit These Files
- `package.json`
- `tsconfig.json`
- `vite.config.ts` (or `esbuild.config.mjs`)
- `manifest.json`
- `index.html`
- `src/main.ts`
- `src/shell/ProductShell.ts`
- `src/shell/shell.css`
- `src/bridge/premiereBridge.ts`
- `src/tools/zoom/ZoomToolPlaceholder.ts`

## Exact Stack
- **Runtime**: Adobe Premiere Pro UXP (v24.2+ / v25.0+, Manifest v5)
- **Language**: TypeScript (ES2022, Strict Mode)
- **UI Architecture**: Vanilla TS/HTML/CSS (no heavy frontend framework)
- **Bundler**: Vite (generating a single `dist/index.js` bundle preserving external `premierepro` and `uxp` requires)
- **Dependencies**: None (0 runtime dependencies)
- **DevDependencies**: `typescript`, `vite`, `@types/node`

## Implementation Requirements
1. **Manifest (`manifest.json`)**:
   - `manifestVersion`: `5`
   - `id`: `com.editplugin.toolbox`
   - `host`: `[{ "app": "PPRO", "minVersion": "24.2.0" }]`
   - `entrypoints`: 1 panel (`type: "panel"`, `id: "mainPanel"`, `label: "Edit Toolbox"`)
   - `requiredPermissions`: `localFileSystem: "fullAccess"`, `network: { "domains": "all" }`
2. **Product Shell UI (Graybox)**:
   - Header with platform title and Premiere connection status badge.
   - Category selector tabs (`Edição`, `Áudio`, `Legendas`, `Projeto`, `Mídia`).
   - Active Tool Workspace area rendering `ZoomToolPlaceholder`.
3. **Premiere DOM Bridge (`src/bridge/premiereBridge.ts`)**:
   - Safely import host module: `const app = require('premierepro');`
   - Implement read-only health check: `getActiveProjectName()` and `getActiveSequenceName()`.
   - Handle disconnected/mock state gracefully if run outside Premiere.
4. **Zoom Tool Placeholder (`src/tools/zoom/ZoomToolPlaceholder.ts`)**:
   - Render title "Zoom In / Out", brief description, and disabled "Apply" button.
5. **Entrypoint (`index.html` / `src/main.ts`)**:
   - Mount `ProductShell` and execute DOM bridge check on load.

## Commands
```bash
npm install
npm run build
npm run typecheck
```

## Acceptance Criteria
1. [ ] `npm run build` succeeds without warnings, producing `dist/index.js`.
2. [ ] `npm run typecheck` passes with zero TypeScript errors.
3. [ ] `manifest.json` conforms strictly to UXP Manifest v5 specifications.
4. [ ] Loading the plugin folder in UXP Developer Tool (UDT) loads the panel into Premiere Pro without manifest/syntax errors.
5. [ ] When loaded in Premiere with an active project, the panel displays the active project and sequence name.
6. [ ] Zero runtime dependencies in `package.json`.

## Manual Validation
1. Open Premiere Pro (v24.2+) and load plugin via UXP Developer Tool.
2. Verify panel "Edit Toolbox" appears under `Window > Extensions` (or `Plugins`).
3. Verify project name updates upon opening a project.

## Do Not Do
- Do not implement Zoom logic or keyframing (belongs to Task 02).
- Do not install React, Vue, Tailwind, or component libraries.
- Do not implement AI, Artlist, audio processing, or network calls.
- Do not explore codebase beyond the specified files.
- Do not create additional documentation or plans.
