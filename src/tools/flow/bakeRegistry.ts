/**
 * Quais keyframes NÓS assamos — e por que isso precisa sobreviver ao
 * fechamento do painel.
 *
 * ── O problema ────────────────────────────────────────────────────
 * O Premiere não oferece lugar nenhum para marcar um keyframe como
 * sendo do plugin, e também não diz quais keyframes o editor
 * selecionou. A única forma de distinguir um âncora do editor de um
 * keyframe que o bake criou é LEMBRAR o que foi escrito.
 *
 * Enquanto essa lembrança vivia só na memória do painel, ela morria a
 * cada recarga do plugin, troca de painel ou reinício do Premiere. E o
 * estrago era silencioso: um parâmetro com dois âncoras vira dezoito
 * keyframes depois da primeira curva; reabrindo o painel, os dezoito
 * passam a ser lidos como âncoras do editor, a segunda curva assa
 * entre CADA par, e o parâmetro termina com cerca de cento e vinte
 * keyframes. Ninguém avisa nada, e desfazer no Premiere é caro.
 *
 * ── A cerca ───────────────────────────────────────────────────────
 * O registro é uma dica, nunca uma verdade: `anchorsOf` descarta o que
 * o parâmetro não tem mais e ignora o registro inteiro quando ele
 * deixaria menos de dois âncoras. Então um arquivo velho, corrompido
 * ou de outra máquina degrada para o comportamento antigo, que é ruim,
 * e nunca para um que apaga trabalho.
 *
 * A chave do parâmetro embute a identidade do clipe (`ClipRef.key`),
 * que é feita do nome da mídia e dos pontos de entrada e saída — ela
 * sobrevive a arrastar o clipe pela timeline. O arquivo é separado por
 * projeto, senão dois projetos com clipes de mesmo nome herdariam o
 * registro um do outro.
 */
import type { Project } from "@adobe/premierepro";
import { readText, workspace, write } from "../silence/workspace";

const FILE = "flow-baked.json";

/**
 * Quantos projetos o arquivo guarda. Sem teto ele cresce para sempre,
 * e o registro de um projeto que não se abre há meses não vale o disco
 * nem o tempo de parse.
 */
const MAX_PROJECTS = 24;

interface StoredProject {
  updated: string;
  params: Record<string, string[]>;
}

interface Stored {
  version: 1;
  projects: Record<string, StoredProject>;
}

/**
 * Ticks que este plugin assou, por parâmetro. Chaveado por
 * `ClipRef.key` mais o endereço do parâmetro.
 */
const bakedByParam = new Map<string, Set<string>>();

/** O projeto cujo registro está carregado. `null` = nada carregado. */
let loadedFor: string | null = null;

/** Evita duas cargas em paralelo lendo o arquivo duas vezes. */
let loading: Promise<void> | null = null;

/**
 * Identidade do projeto para separar os registros.
 *
 * O caminho é o que distingue dois projetos de mesmo nome. Quando o
 * host não responde, o nome serve; e quando nem isso, tudo cai num
 * balde só — que é pior, mas continua funcionando.
 */
export function projectKey(project: Project | null): string {
  if (!project) {
    return "(sem projeto)";
  }
  try {
    const path = project.path;
    if (typeof path === "string" && path.trim() !== "") {
      return path;
    }
  } catch {
    /* host não respondeu o caminho */
  }
  try {
    const name = project.name;
    if (typeof name === "string" && name.trim() !== "") {
      return `nome:${name}`;
    }
  } catch {
    /* nem o nome */
  }
  return "(sem projeto)";
}

function parse(raw: string | null): Stored {
  if (!raw) {
    return { version: 1, projects: {} };
  }
  try {
    const data = JSON.parse(raw) as Partial<Stored>;
    if (!data || data.version !== 1 || typeof data.projects !== "object") {
      return { version: 1, projects: {} };
    }
    return { version: 1, projects: data.projects as Record<string, StoredProject> };
  } catch {
    // Arquivo corrompido não é motivo para derrubar a ferramenta: o
    // registro volta vazio e o pior que acontece é o comportamento
    // antigo, que já era o que se tinha.
    return { version: 1, projects: {} };
  }
}

async function readStored(): Promise<Stored> {
  try {
    const space = await workspace();
    return parse(readText(space, FILE));
  } catch {
    return { version: 1, projects: {} };
  }
}

/**
 * Carrega o registro deste projeto para a memória. Trocar de projeto
 * recarrega; o mesmo projeto não relê.
 */
export async function ensureRegistryLoaded(project: Project | null): Promise<void> {
  const key = projectKey(project);
  if (loadedFor === key) {
    return;
  }
  if (loading) {
    await loading;
    if (loadedFor === key) {
      return;
    }
  }

  loading = (async () => {
    const stored = await readStored();
    bakedByParam.clear();
    const entry = stored.projects[key];
    if (entry && entry.params) {
      for (const [paramKey, ticks] of Object.entries(entry.params)) {
        if (Array.isArray(ticks) && ticks.length > 0) {
          bakedByParam.set(paramKey, new Set(ticks.filter((t) => typeof t === "string")));
        }
      }
    }
    loadedFor = key;
  })();

  try {
    await loading;
  } finally {
    loading = null;
  }
}

/**
 * Grava o registro deste projeto. Relê o arquivo antes de escrever
 * para não apagar o registro de OUTRO projeto que outra janela do
 * Premiere possa ter gravado no meio tempo.
 */
export async function persistRegistry(project: Project | null): Promise<void> {
  const key = projectKey(project);
  try {
    const space = await workspace();
    const stored = parse(readText(space, FILE));

    const params: Record<string, string[]> = {};
    for (const [paramKey, ticks] of bakedByParam) {
      if (ticks.size > 0) {
        params[paramKey] = [...ticks];
      }
    }

    if (Object.keys(params).length === 0) {
      delete stored.projects[key];
    } else {
      stored.projects[key] = { updated: new Date().toISOString(), params };
    }

    // Os mais recentes primeiro; o excedente sai.
    const ordered = Object.entries(stored.projects).sort(
      (a, b) => (b[1]?.updated ?? "").localeCompare(a[1]?.updated ?? "")
    );
    stored.projects = Object.fromEntries(ordered.slice(0, MAX_PROJECTS));

    await write(space, FILE, JSON.stringify(stored));
  } catch (cause) {
    // Não conseguir gravar custa a lembrança na próxima sessão, não a
    // aplicação que acabou de dar certo.
    console.warn("[Flow] não consegui gravar o registro de assadura:", cause);
  }
}

/** O conjunto de ticks assados de um parâmetro, criando-o se preciso. */
export function bakedFor(key: string): Set<string> {
  let set = bakedByParam.get(key);
  if (!set) {
    set = new Set<string>();
    bakedByParam.set(key, set);
  }
  return set;
}

/** O conjunto já existente, sem criar. */
export function bakedIfAny(key: string): Set<string> | undefined {
  return bakedByParam.get(key);
}

/** Esquece um parâmetro por completo. */
export function forgetParam(key: string): void {
  bakedByParam.delete(key);
}
