/**
 * A troca dos arquivos do plugin, em duas fases.
 *
 * ── Por que isto existe ───────────────────────────────────────────
 * O atualizador já baixava o lote INTEIRO para a memória antes de
 * gravar um byte, e isso resolvia a queda de rede: sem os quatro
 * arquivos em mão, nada no disco era tocado. Mas a GRAVAÇÃO seguia
 * arquivo por arquivo, direto na instalação em execução, sem cópia de
 * segurança. Uma falha no segundo dos quatro — disco cheio, permissão,
 * uma build do host que recuse `ArrayBuffer` num arquivo grande —
 * deixava `index.html` da versão nova ao lado de `index.js` da antiga.
 * O painel não abre nesse estado, e o próprio atualizador, que mora no
 * bundle quebrado, não está lá para tentar de novo.
 *
 * ── A regra ───────────────────────────────────────────────────────
 * Uma atualização termina em UM de dois estados: a instalação antiga
 * inteira, ou a nova inteira. Estado misto não é um final aceitável
 * enquanto a falha for tratável.
 *
 * ── Como ──────────────────────────────────────────────────────────
 *   1. ENSAIO    grava cada arquivo novo ao lado, com sufixo `.new`.
 *                É aqui que disco cheio, permissão e formato recusado
 *                aparecem — quando nenhum arquivo ativo foi tocado
 *                ainda e desistir não custa nada.
 *   2. CÓPIA     lê os bytes de cada arquivo ativo para a memória e
 *                grava um `.bak` ao lado. Sem poder voltar, não se vai.
 *   3. TROCA     põe os novos no lugar. Rename quando o runtime tem
 *                (uma operação, sem reescrever bytes); senão, escrita.
 *   4a. LIMPEZA  deu certo: `.new` e `.bak` saem.
 *   4b. VOLTA    falhou no meio: cada arquivo já trocado é restaurado
 *                da CÓPIA EM MEMÓRIA, que é a que não depende do disco
 *                ter aceitado o `.bak`.
 *
 * Se a volta também falhar, os `.bak` ficam onde estão e o erro diz
 * isso com todas as letras, nomeando os arquivos. Um estado misto que
 * se anuncia é recuperável à mão; um que se cala, não.
 *
 * ── Por que mora fora do updater ──────────────────────────────────
 * Para poder ser provado. `applyUpdate` fala com `require("uxp")` e com
 * a rede; aqui só existe a máquina de estados, atrás de uma porta
 * estreita (`InstallTarget`) que o teste implementa em memória e faz
 * falhar em qualquer passo. Mesma razão de `fetchAllBytes` ter sido
 * separada da escrita em `panelFetch.ts`.
 */

/** Um arquivo do bundle, já inteiro em memória. */
export interface BundleFile {
  readonly filename: string;
  readonly data: ArrayBuffer;
}

/**
 * O mínimo que a transação precisa da pasta do plugin.
 *
 * Três operações obrigatórias, todas com padrão já provado no projeto
 * (ver `sfx/folder.ts` e `bridge/destination.ts`), e uma opcional.
 */
export interface InstallTarget {
  /** Grava (ou sobrescreve) um arquivo da pasta. Lança se não der. */
  writeFile(name: string, data: ArrayBuffer): Promise<void>;
  /** Os bytes de um arquivo, ou `null` se ele ainda não existe. */
  readFile(name: string): Promise<ArrayBuffer | null>;
  /** Apaga um arquivo. Não existir não é falha. */
  deleteFile(name: string): Promise<void>;
  /**
   * Renomeia `stagedName` sobre `targetName`.
   *
   * Ausente quando esta build não oferece a operação — e é por isso que
   * ela é opcional: o UXP do Premiere não promete `moveTo`, e a
   * transação não pode depender de uma API que talvez não exista. Com
   * ela a troca é uma operação só; sem ela, é uma escrita a partir da
   * memória, que é o que o atualizador sempre fez.
   */
  replaceFrom?(stagedName: string, targetName: string): Promise<void>;
}

export interface InstallProgress {
  (step: string, percent: number): void;
}

export interface InstallOutcome {
  ok: boolean;
  /**
   * true SÓ no estado que não deveria existir: a troca falhou e a volta
   * também. A instalação está misturada e o editor precisa saber.
   */
  critical: boolean;
  message: string;
  /** Arquivos que a volta não conseguiu restaurar. Vazio quando ok. */
  unrestored: string[];
}

/** Sufixos próprios, para um resto esquecido ser reconhecível. */
const STAGED = ".framelab-new";
const BACKUP = ".framelab-bak";

/** A faixa de porcentagem da troca, para a barra continuar a mesma. */
const COMMIT_FROM = 60;
const COMMIT_SPAN = 35;

/**
 * Instala o lote. **Nunca lança**: todo final é um `InstallOutcome`,
 * porque quem chama precisa distinguir "não mudou nada" de "mudou pela
 * metade" — e uma exceção não sabe dizer a diferença.
 */
export async function installBundle(
  target: InstallTarget,
  files: readonly BundleFile[],
  onProgress?: InstallProgress
): Promise<InstallOutcome> {
  if (files.length === 0) {
    return refused("Nenhum arquivo para instalar.");
  }
  // Um arquivo vazio passaria pelo `response.ok` e pelo tamanho do
  // lote, e só apareceria como painel em branco depois do reload.
  const empty = files.filter((file) => file.data.byteLength === 0);
  if (empty.length > 0) {
    return refused(
      `A atualização veio com arquivo vazio (${empty
        .map((file) => file.filename)
        .join(", ")}). Nada foi alterado.`
    );
  }

  /** O que já foi escrito ao lado, para sair na limpeza. */
  const staged: string[] = [];
  /** Os bytes de antes. `null` = o arquivo não existia. */
  const backups = new Map<string, ArrayBuffer | null>();
  /** Gravados, para a volta saber o que desfazer. */
  const committed: string[] = [];

  // ── 1. ensaio ────────────────────────────────────────────────────
  onProgress?.("Preparando os arquivos...", 55);
  for (const file of files) {
    const name = `${file.filename}${STAGED}`;
    try {
      await target.writeFile(name, file.data);
      staged.push(name);
    } catch (cause) {
      await discard(target, staged, backups);
      return refused(
        `A pasta do plugin não aceitou ${file.filename} (${describe(cause)}). ` +
          "Nada foi alterado."
      );
    }
  }

  // ── 2. cópia de segurança ────────────────────────────────────────
  for (const file of files) {
    let held: ArrayBuffer | null;
    try {
      held = await target.readFile(file.filename);
    } catch (cause) {
      // Sem conseguir ler o que está lá, não há volta possível — e uma
      // troca sem volta é exatamente o que este módulo existe para não
      // fazer.
      await discard(target, staged, backups);
      return refused(
        `Não consegui ler ${file.filename} para guardar uma cópia ` +
          `(${describe(cause)}). Nada foi alterado.`
      );
    }
    backups.set(file.filename, held);
    if (held === null) {
      // Arquivo novo no bundle: a volta é apagá-lo, e isso não precisa
      // de `.bak`.
      continue;
    }
    try {
      await target.writeFile(`${file.filename}${BACKUP}`, held);
    } catch (cause) {
      // O ensaio já provou que a pasta aceita escrita; falhar aqui diz
      // que algo mudou no meio. Parar antes da troca é o barato.
      await discard(target, staged, backups);
      return refused(
        `Não consegui guardar a cópia de ${file.filename} ` +
          `(${describe(cause)}). Nada foi alterado.`
      );
    }
  }

  // ── 3. a troca ───────────────────────────────────────────────────
  for (let at = 0; at < files.length; at += 1) {
    const file = files[at];
    onProgress?.(
      `Gravando ${file.filename}...`,
      COMMIT_FROM + Math.round((at / files.length) * COMMIT_SPAN)
    );
    try {
      await replace(target, file);
      committed.push(file.filename);
    } catch (cause) {
      return await rollback(target, files, staged, backups, committed, cause);
    }
  }

  // ── 4a. limpeza ──────────────────────────────────────────────────
  // Só agora, com a troca inteira no lugar: apagar um `.bak` antes
  // disso seria jogar fora a volta enquanto ela ainda pode ser
  // necessária. Uma limpeza que falhe não estraga nada — sobra um
  // arquivo a mais na pasta, e o painel novo está inteiro.
  await discard(target, staged, backups);

  onProgress?.("Atualização concluída!", 100);
  return { ok: true, critical: false, message: "", unrestored: [] };
}

/** A troca de um arquivo, pela operação mais segura que houver. */
async function replace(target: InstallTarget, file: BundleFile): Promise<void> {
  const stagedName = `${file.filename}${STAGED}`;
  if (typeof target.replaceFrom === "function") {
    try {
      await target.replaceFrom(stagedName, file.filename);
      return;
    } catch (cause) {
      // Rename recusado nesta build: a escrita a partir da memória é o
      // caminho que o atualizador sempre usou.
      console.warn(`[Updater] rename recusado em ${file.filename}:`, cause);
    }
  }
  await target.writeFile(file.filename, file.data);
}

/**
 * Devolve cada arquivo já trocado ao que era.
 *
 * A restauração vem da cópia EM MEMÓRIA, e não do `.bak`: é a que não
 * depende de o disco ter aceitado o `.bak`, e a que continua valendo se
 * o `.bak` tiver sido escrito pela metade.
 */
async function rollback(
  target: InstallTarget,
  files: readonly BundleFile[],
  staged: string[],
  backups: Map<string, ArrayBuffer | null>,
  committed: readonly string[],
  cause: unknown
): Promise<InstallOutcome> {
  const failed = files.find((file) => !committed.includes(file.filename));
  const unrestored: string[] = [];

  for (const name of committed) {
    const held = backups.get(name);
    try {
      if (held === null || held === undefined) {
        // Não existia antes: a volta é não existir agora.
        await target.deleteFile(name);
      } else {
        await target.writeFile(name, held);
      }
    } catch (restoreCause) {
      console.error(`[Updater] não consegui restaurar ${name}:`, restoreCause);
      unrestored.push(name);
    }
  }

  const step = failed ? failed.filename : "um arquivo";
  if (unrestored.length === 0) {
    // Voltou inteiro: a instalação antiga está consistente, e os
    // rastros podem sair.
    await discard(target, staged, backups);
    return {
      ok: false,
      critical: false,
      message:
        `Falha ao gravar ${step} (${describe(cause)}). ` +
        "A versão anterior foi restaurada e continua funcionando.",
      unrestored: [],
    };
  }

  /*
   * O estado que não deveria existir. Os `.bak` e os `.new` FICAM —
   * são o material de recuperação — e a mensagem nomeia os arquivos,
   * porque um painel que não abre mais não tem como contar isso depois.
   */
  return {
    ok: false,
    critical: true,
    message:
      `FALHA CRÍTICA na atualização: ${step} não foi gravado ` +
      `(${describe(cause)}) e não consegui restaurar ` +
      `${unrestored.join(", ")}. A instalação está MISTURADA e o painel ` +
      "pode não abrir. Na pasta do plugin, os arquivos terminados em " +
      `"${BACKUP}" são a versão anterior: renomeie cada um removendo esse ` +
      "sufixo, ou reinstale o plugin pelo instalador do GitHub.",
    unrestored,
  };
}

/**
 * Apaga os rastros da transação. Nunca lança: um resto na pasta não
 * justifica derrubar uma atualização que deu certo.
 */
async function discard(
  target: InstallTarget,
  staged: readonly string[],
  backups: ReadonlyMap<string, ArrayBuffer | null>
): Promise<void> {
  for (const name of staged) {
    try {
      // Com rename, o `.new` já virou o arquivo ativo e não está mais
      // aqui — apagar o que não existe é o caso comum, não uma falha.
      await target.deleteFile(name);
    } catch (cause) {
      console.warn(`[Updater] sobrou ${name} na pasta do plugin:`, cause);
    }
  }
  for (const [name, held] of backups) {
    if (held === null) {
      continue;
    }
    try {
      await target.deleteFile(`${name}${BACKUP}`);
    } catch (cause) {
      console.warn(`[Updater] sobrou ${name}${BACKUP} na pasta do plugin:`, cause);
    }
  }
}

function refused(message: string): InstallOutcome {
  return { ok: false, critical: false, message, unrestored: [] };
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
