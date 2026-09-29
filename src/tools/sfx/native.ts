/**
 * A prévia pelo próprio macOS: `afplay`, executado pelo assistente.
 *
 * ── Por que existe ─────────────────────────────────────────────────
 * O <video> do UXP abre o arquivo, diz que está tocando (`paused`
 * falso, `play()` resolvido) e o tempo não sai de 0,00 — medido com
 * quatro maneiras diferentes de pedir (ver `player.ts`). O `afplay` é
 * o tocador de linha de comando que vem no macOS: toca qualquer WAV,
 * MP3 ou AAC pela saída de áudio padrão, sem janela.
 *
 * Quem o executa é o assistente residente do Framelab (`runner.ts`),
 * o mesmo que já roda ffmpeg, whisper e yt-dlp sem abrir Terminal. Se
 * ele já estiver de pé, nenhuma pergunta; se não, o macOS pede
 * autorização UMA vez por sessão do Premiere.
 *
 * O script sai logo depois de soltar o `afplay` em segundo plano, então
 * não prende a fila do assistente. O pid fica num arquivo: é por ele
 * que uma prévia nova cala a anterior, e que parar funciona.
 *
 * ── "Tocou" só quando tocou ────────────────────────────────────────
 * A primeira versão confirmava assim que SOLTAVA o tocador — e o
 * afplay morria em seguida, calado, sem permissão para ler a pasta do
 * Google Drive ("AudioFileOpen failed (-54)"). O relatório dizia
 * "tocou" para um som que ninguém ouviu. Agora o script espera um
 * instante e só confirma se o afplay continua vivo (ou terminou bem);
 * se morreu, devolve o erro dele. E o arquivo que ele recebe é sempre
 * a cópia temporária (ver `preview.ts`), que o macOS deixa ler.
 */
import { agentStatus, dispatch, withdraw } from "../download/runner";
import {
  isWindows,
  nativePath,
  readText,
  remove,
  shellQuote,
  wait,
  workspace,
  write,
  type Workspace,
} from "../silence/workspace";

const STOP_SCRIPT = "sfx-stop.command";
/**
 * O pid é COMPARTILHADO de propósito, e é o único que é.
 *
 * É por ele que uma prévia nova cala a anterior e que `stopNative`
 * funciona: o script começa matando o pid que encontrar ali. Carimbá-lo
 * por execução tiraria justamente isso — cada prévia tocaria por cima da
 * outra, e parar deixaria de parar.
 */
const PID_FILE = "sfx-afplay.pid";

/**
 * Os artefatos de UMA prévia.
 *
 * ── Por que carimbados ────────────────────────────────────────────
 * O script tinha nome fixo, e o assistente executa o arquivo que o
 * ticket NOMEIA, lendo-o na hora de executar. Entre escrever e executar
 * cabe outra prévia: ouvir dois sons em sequência — o gesto de quem
 * procura um efeito numa lista — fazia a prévia B sobrescrever o script
 * antes de o ticket de A rodar. O ticket de A então executava B, B
 * tocava duas vezes, e A esperava um carimbo que nunca vinha para
 * terminar com "o assistente não respondeu em 2,5s". O arquivo de
 * resposta também era fixo, então B ainda apagava a resposta de A.
 *
 * O ytdlp e o whisper já resolviam isso carimbando por execução; este
 * módulo não. Agora cada prévia tem os seus três, e nenhum deles é nome
 * que outra prévia possa escrever.
 */
export interface PreviewRun {
  /** A etiqueta desta prévia, também dentro do carimbo. */
  readonly tag: string;
  /** O script que o ticket vai nomear. */
  readonly script: string;
  /** Onde o script confirma (ou nega) que tocou. */
  readonly started: string;
  /** Onde o `afplay` deixa o que reclamou. */
  readonly errors: string;
}

/**
 * Um contador, e não só o relógio.
 *
 * `Date.now()` em milissegundos repete entre dois cliques rápidos — que
 * é exatamente o caso que este carimbo existe para separar.
 */
let sequence = 0;

export function previewRun(): PreviewRun {
  const tag = `p${Date.now().toString(36)}-${(sequence += 1).toString(36)}`;
  return {
    tag,
    script: `sfx-play-${tag}.command`,
    started: `sfx-play-${tag}-started.txt`,
    errors: `sfx-play-${tag}-error.txt`,
  };
}

/**
 * O que esta prévia deixou na pasta de trabalho, para limpar.
 *
 * O pid NÃO está aqui: ele é de todas, e apagá-lo no fim de uma prévia
 * cortaria o `stopNative` da que ainda estiver tocando.
 */
export function runFiles(run: PreviewRun): string[] {
  return [run.script, run.started, run.errors];
}

/** O caminho nativo de uma URL `file://`, para o `afplay`. */
export function nativeFileOf(url: string): string | null {
  if (!url.startsWith("file://")) return null;
  try {
    return decodeURIComponent(url.slice("file://".length));
  } catch {
    return null;
  }
}

export function nativeAvailable(): boolean {
  return !isWindows();
}

/**
 * O texto do script desta prévia.
 *
 * Separado de `playNative` por ser a parte que dá para provar fora do
 * host: o que estava errado não era o comando, era ele estar num arquivo
 * que outra prévia podia reescrever.
 */
export function previewScript(
  run: PreviewRun,
  file: string,
  space: Workspace
): string {
  const q = shellQuote;
  const pid = nativePath(space, PID_FILE);
  const started = nativePath(space, run.started);
  const errors = nativePath(space, run.errors);
  return [
    "#!/bin/bash",
    "# Gerado pelo Framelab — prévia de efeito sonoro. Pode apagar.",
    `if [ -f ${q(pid)} ]; then kill "$(cat ${q(pid)})" 2>/dev/null; fi`,
    `nohup /usr/bin/afplay ${q(file)} >/dev/null 2>${q(errors)} &`,
    "P=$!",
    `echo $P > ${q(pid)}`,
    // Um instante para o afplay abrir o arquivo e a saída de áudio.
    "sleep 0.2",
    "if kill -0 $P 2>/dev/null; then",
    `  echo "${run.tag} ok" > ${q(started)}`,
    "else",
    "  wait $P; CODE=$?",
    '  if [ "$CODE" -eq 0 ]; then',
    `    echo "${run.tag} ok" > ${q(started)}`,
    "  else",
    `    echo "${run.tag} falhou $(tr '\\n' ' ' < ${q(errors)} | head -c 200)" > ${q(started)}`,
    "  fi",
    "fi",
    "",
  ].join("\n");
}

/**
 * Toca pelo `afplay`. `ok` só quando o script CONFIRMOU que soltou o
 * tocador — escrevendo a etiqueta desta prévia no arquivo de carimbo
 * DELA. Cada chamada tem os seus artefatos: ver `PreviewRun`.
 */
export async function playNative(file: string): Promise<{ ok: boolean; detail: string }> {
  if (isWindows()) return { ok: false, detail: "afplay só existe no macOS" };
  const space = await workspace();
  const run = previewRun();
  await write(space, run.script, previewScript(run, file, space), true);

  const sent = await dispatch(run.script);
  if (sent.mode === "denied") {
    await forget(space, run);
    return { ok: false, detail: `assistente recusado (${sent.error ?? "sem motivo"})` };
  }
  // Lançar o assistente agora inclui o diálogo de autorização do macOS:
  // o prazo espera o editor responder.
  const limit = sent.mode === "launched" ? 20000 : 2500;
  for (let waited = 0; waited < limit; waited += 100) {
    // O arquivo é só desta prévia, e a etiqueta dentro dele é a segunda
    // cerca: nenhuma outra execução escreve aqui.
    const answer = readText(space, run.started) ?? "";
    if (answer === `${run.tag} ok`) {
      await forget(space, run);
      return { ok: true, detail: sent.mode };
    }
    if (answer.startsWith(`${run.tag} falhou`)) {
      const why = answer.slice(run.tag.length + 8).trim();
      await forget(space, run);
      return { ok: false, detail: `o afplay não tocou: ${why || "sem mensagem"}` };
    }
    await wait(100);
  }
  // Sem resposta: o pedido sai da fila, senão um assistente que
  // acordasse depois tocaria um som que ninguém espera mais.
  await withdraw(sent.ticket);
  await forget(space, run);
  return { ok: false, detail: `o assistente não respondeu em ${limit / 1000}s (${sent.mode})` };
}

/**
 * Apaga o que ESTA prévia deixou, e só isso.
 *
 * Os nomes são exclusivos, então nenhuma limpeza alcança o script ou a
 * resposta de uma prévia que ainda esteja de pé. No Unix apagar um
 * script em execução é seguro — o descritor aberto sobrevive ao unlink —
 * e apagá-lo depois de retirar o ticket é o que impede um assistente
 * atrasado de tocar um som que ninguém espera mais.
 */
async function forget(space: Workspace, run: PreviewRun): Promise<void> {
  for (const name of runFiles(run)) {
    await remove(space, name);
  }
}

/** Cala o `afplay` desta prévia. Não acorda o assistente para isso. */
export async function stopNative(): Promise<void> {
  if (isWindows()) return;
  try {
    if (!(await agentStatus()).up) return;
    const space = await workspace();
    const q = shellQuote;
    const pid = nativePath(space, PID_FILE);
    await write(
      space,
      STOP_SCRIPT,
      [
        "#!/bin/bash",
        "# Gerado pelo Framelab — para a prévia de efeito sonoro. Pode apagar.",
        `if [ -f ${q(pid)} ]; then kill "$(cat ${q(pid)})" 2>/dev/null; rm -f ${q(pid)}; fi`,
        "",
      ].join("\n"),
      true
    );
    await dispatch(STOP_SCRIPT);
  } catch {
    // O som termina sozinho; um efeito dura segundos.
  }
}
