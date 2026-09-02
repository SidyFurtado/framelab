#!/usr/bin/env node
/**
 * Banco de aferição das Legendas.
 *
 * ── Por que existe ─────────────────────────────────────────────────
 * "Melhorou" sem número é chute. Este script é a régua: fixa um
 * conjunto de falas com resposta conhecida, roda o pipeline REAL
 * (mesmo modelo, mesmas flags, mesmo glossário e mesmo corretor que o
 * painel usa) e devolve taxa de erro de palavra, acentuação e
 * pontuação.
 *
 * É o que permite mexer numa flag de decodificação, trocar de modelo
 * ou acrescentar termo de fábrica e SABER se ficou melhor — em vez de
 * publicar esperança. Toda mudança no pipeline de legenda deveria
 * passar por aqui antes de virar release.
 *
 * ── Como rodar ─────────────────────────────────────────────────────
 *   npm run bench:captions
 *
 * Precisa de: whisper-cli, ffmpeg e a voz Luciana do macOS (que é
 * síntese — mede o pipeline e o vocabulário, não a robustez a ruído
 * real. Fala gravada de verdade é o próximo degrau desta régua.)
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const WORK = path.join(os.tmpdir(), "framelab-captions-bench");
const MODEL_FILE = "ggml-large-v3-turbo-q5_0.bin";
const MODEL_URL =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/" + MODEL_FILE;

/**
 * As falas de prova. Cada uma existe por um motivo declarado — um
 * caso que já falhou ou que se espera que falhe.
 */
const FIXTURES = [
  {
    id: "pontuacao",
    porque: "vírgula, interrogação e acento em fala corrida",
    texto:
      "Então, olha só, o que a gente vai fazer hoje é bem simples. " +
      "Você já tentou cortar isso na mão? Leva umas três horas, no mínimo. " +
      "A ideia, no fundo, é você não perder tempo com o que a máquina faz melhor. " +
      "Ficou claro? Ótimo, então bora.",
  },
  {
    id: "jargao",
    porque: "termo técnico em inglês dito com sotaque, e nome próprio",
    texto:
      "No Framelab você abre o painel, seleciona o clipe e roda o corte de silêncios. " +
      "Depois aplica um punch in com keyframe no Transform, joga um b-roll por cima e exporta. " +
      "Quem me pediu foi o Sidy, e a Larissa também.",
  },
  {
    id: "formato",
    porque: "número e sigla, que o modelo escreve por extenso",
    texto:
      "Exporta em 4K, mas a versão do story vai em 9:16. " +
      "O codec é H 264 e o frame rate fica em 24 quadros por segundo.",
  },
];

// ── medida ─────────────────────────────────────────────────────────

const palavras = (t) => (t.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);

/** Distância de edição em nível de palavra: a base do WER. */
function wer(ref, hyp) {
  const r = palavras(ref);
  const h = palavras(hyp);
  let prev = Array.from({ length: h.length + 1 }, (_, i) => i);
  for (let i = 1; i <= r.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= h.length; j += 1) {
      cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r[i - 1] !== h[j - 1] ? 1 : 0)));
    }
    prev = cur;
  }
  return { erros: prev[h.length], total: r.length };
}

const acentos = (t) => (t.match(/[áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÜÇ]/g) || []).length;
const conta = (t, ch) => t.split(ch).length - 1;

// ── execução ───────────────────────────────────────────────────────

function acha(nomes) {
  for (const n of nomes) {
    try {
      // `which` em vez de `command -v` com shell: passar argumento por
      // shell não escapa nada, e aqui não há por que abrir essa porta.
      const found = execFileSync("/usr/bin/which", [n], { encoding: "utf8" }).trim();
      if (found) return found;
    } catch {
      /* segue */
    }
  }
  return "";
}

/**
 * O corretor de glossário do painel, compilado na hora.
 *
 * A régua tem que medir o pipeline INTEIRO. Sem esta segunda camada
 * ela media só o viés do prompt e dava a qualidade por pior do que é
 * — foi o primeiro defeito que ela encontrou, no próprio corpo dela.
 */
function carregaCorretor() {
  const out = path.join(WORK, "glossary.cjs");
  try {
    execFileSync("npx", ["esbuild", "src/tools/captions/glossary.ts",
      "--bundle", "--platform=node", "--format=cjs", "--outfile=" + out,
      "--log-level=error"], { stdio: "ignore" });
    return require(out);
  } catch {
    console.warn("(aviso: corretor não compilou — medindo só o prompt)");
    return null;
  }
}

/** Aplica o corretor sobre o texto puro, como o painel faz nas palavras. */
function corrige(texto, corretor, termos) {
  if (!corretor) return texto;
  const parsed = corretor.parseGlossary(termos.join("\n"));
  const palavras = texto.split(/\s+/).map((t, i) => ({
    text: t, start: i, duration: 0.5, type: "word", confidence: 1, tags: [],
  }));
  const { transcript } = corretor.applyGlossary(
    { version: "1.0.0", segments: [{ start: 0, words: palavras }] }, parsed);
  return transcript.segments[0].words.map((w) => w.text).join(" ");
}

function main() {
  fs.mkdirSync(WORK, { recursive: true });

  const whisper = acha(["whisper-cli", "whisper-cpp"]) ||
    ["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli"].find(fs.existsSync);
  const ffmpeg = acha(["ffmpeg"]);
  if (!whisper || !ffmpeg) {
    console.error("Faltam whisper-cli e/ou ffmpeg. brew install whisper-cpp ffmpeg");
    process.exit(1);
  }

  const model = path.join(WORK, MODEL_FILE);
  if (!fs.existsSync(model)) {
    console.log("Baixando o modelo (só na primeira vez)…");
    execFileSync("curl", ["-fsSL", "--retry", "3", "-o", model, MODEL_URL], { stdio: "inherit" });
  }

  /*
   * O glossário de fábrica, COMPILADO do TypeScript — não raspado do
   * texto-fonte. A raspagem por expressão regular pegava também as
   * palavras dos comentários, e o bench passava a medir um glossário
   * que o painel não usa.
   */
  const bundled = path.join(WORK, "baseGlossary.cjs");
  let termos;
  try {
    execFileSync("npx", ["esbuild", "src/tools/captions/baseGlossary.ts",
      "--bundle", "--platform=node", "--format=cjs", "--outfile=" + bundled,
      "--log-level=error"], { stdio: "ignore" });
    termos = require(bundled).BASE_GLOSSARY.split("\n").filter(Boolean);
  } catch {
    termos = require("./captions-glossary.json");
  }
  const prompt = termos.join(", ") + ".";
  const corretor = carregaCorretor();

  let somaErros = 0;
  let somaPalavras = 0;
  console.log("\n═══ Aferição das Legendas ═══\n");

  for (const fx of FIXTURES) {
    const base = path.join(WORK, fx.id);
    fs.writeFileSync(base + ".txt", fx.texto);
    execFileSync("say", ["-v", "Luciana", "-f", base + ".txt", "-o", base + ".aiff"]);
    execFileSync(ffmpeg, ["-y", "-i", base + ".aiff", "-ar", "16000", "-ac", "1",
      "-c:a", "pcm_s16le", base + ".wav"], { stdio: "ignore" });

    // As MESMAS flags do painel (ver whisper.ts).
    execFileSync(whisper, ["-m", model, "-f", base + ".wav", "-l", "pt",
      "-bs", "5", "-bo", "5", "-sns", "-et", "2.4", "-lpt", "-1.0",
      "--prompt", prompt, "-nt", "-otxt", "-of", base + "-out"], { stdio: "ignore" });

    const cru = fs.readFileSync(base + "-out.txt", "utf8").replace(/\s+/g, " ").trim();
    // As duas camadas, como o painel entrega.
    const saida = corrige(cru, corretor, termos);
    const { erros, total } = wer(fx.texto, saida);
    somaErros += erros;
    somaPalavras += total;

    const marca = erros === 0 ? "✓" : "•";
    console.log(`${marca} ${fx.id}  —  ${fx.porque}`);
    console.log(`   WER ${((erros / total) * 100).toFixed(1)}%  (${erros}/${total} palavras)` +
      `  ·  acentos ${acentos(saida)}/${acentos(fx.texto)}` +
      `  ·  “?” ${conta(saida, "?")}/${conta(fx.texto, "?")}`);
    if (erros > 0) {
      console.log(`   saiu: ${saida.slice(0, 150)}${saida.length > 150 ? "…" : ""}`);
    }
    console.log();
  }

  const geral = (somaErros / somaPalavras) * 100;
  // O que esta régua NÃO mede, para ninguém confiar demais nela:
  // o WER compara em minúsculas, então acerto de caixa (nome próprio,
  // marca) não aparece no número — e as falas são sintetizadas, o que
  // mede vocabulário e pipeline, não robustez a ruído de gravação
  // real. Fala gravada de verdade é o próximo degrau.
  console.log("─".repeat(52));
  console.log(`WER geral: ${geral.toFixed(2)}%  (${somaErros}/${somaPalavras} palavras)`);
  console.log("\nGuarde este número. Toda mudança no pipeline de legenda —");
  console.log("flag, modelo, glossário de fábrica — tem que baixá-lo, não subi-lo.");
}

main();
