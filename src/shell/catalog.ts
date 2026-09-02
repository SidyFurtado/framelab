import type { Category, Tool } from "./tool";
import { zoomTool } from "../tools/zoom/zoomTool";
import { flowTool } from "../tools/flow/flowTool";
import { silenceTool } from "../tools/silence/silenceTool";
import { organizeTool } from "../tools/organize/organizeTool";
import { downloadTool } from "../tools/download/downloadTool";
import { fillersTool } from "../tools/fillers/fillersTool";
import { captionsTool } from "../tools/captions/captionsTool";

/**
 * The catalogue. Adding a Tool means writing it and listing it here —
 * no registry machinery until the platform actually needs one. Only
 * shipped Tools are listed; there are no placeholder entries.
 */
export const categories: readonly Category[] = [
  { id: "edicao", name: "Edição" },
  { id: "texto", name: "Texto" },
  { id: "midia", name: "Mídia" },
  { id: "projeto", name: "Projeto" },
];

export const tools: readonly Tool[] = [
  zoomTool,
  silenceTool,
  fillersTool,
  flowTool,
  captionsTool,
  downloadTool,
  organizeTool,
];

export function toolsIn(categoryId: string): Tool[] {
  return tools.filter((tool) => tool.category === categoryId);
}

export function findTool(toolId: string): Tool | undefined {
  return tools.find((tool) => tool.id === toolId);
}

export function searchTools(query: string): Tool[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [];
  }
  return tools.filter(
    (tool) =>
      tool.name.toLowerCase().includes(needle) ||
      tool.summary.toLowerCase().includes(needle)
  );
}
