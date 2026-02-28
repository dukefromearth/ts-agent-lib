/** @type {import("dependency-cruiser").IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular-src",
      severity: "error",
      comment: "Circular dependencies in src/ make scheduling behavior harder to reason about.",
      from: { path: "^src/" },
      to: { circular: true }
    },
    {
      name: "src-not-to-tests",
      severity: "error",
      comment: "Production code in src/ must not depend on test modules.",
      from: { path: "^src/" },
      to: { path: "^tests/" }
    },
    {
      name: "not-to-unresolvable",
      severity: "error",
      comment: "All imports must resolve on disk.",
      from: {},
      to: { couldNotResolve: true }
    }
  ],
  options: {
    includeOnly: ["^(src|tests)/"],
    doNotFollow: {
      path: ["^node_modules/"]
    },
    tsConfig: {
      fileName: "tsconfig.json"
    },
    tsPreCompilationDeps: true,
    detectProcessBuiltinModuleCalls: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".js", ".mjs", ".cjs"],
      mainFields: ["types", "module", "main"]
    },
    reporterOptions: {
      text: {
        highlightFocused: true
      }
    }
  }
};
