/**
 * Resolve `./foo` como `./foo.ts`.
 *
 * O código do plugin é empacotado pelo vite, que resolve a extensão
 * sozinho. O Node não: em ESM o especificador é literal. Sem este
 * gancho, testar qualquer arquivo que importe outro do projeto exigiria
 * reescrever todos os imports só para agradar o executor de testes.
 */
export async function resolve(specifier, context, next) {
  const relative = specifier.startsWith("./") || specifier.startsWith("../");
  if (relative && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    try {
      return await next(`${specifier}.ts`, context);
    } catch {
      try {
        return await next(`${specifier}/index.ts`, context);
      } catch {
        /* não era um arquivo do projeto; segue o fluxo normal */
      }
    }
  }
  return next(specifier, context);
}
