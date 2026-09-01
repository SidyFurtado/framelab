// UXP exposes host modules through the CommonJS-style `require` global.
declare function require(
  moduleName: "premierepro"
): import("@adobe/premierepro").premierepro;
declare function require(moduleName: string): unknown;
