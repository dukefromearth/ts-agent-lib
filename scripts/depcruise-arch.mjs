#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const CONFIG_FILE = ".dependency-cruiser.cjs";
const TARGETS = ["src", "tests"];
const MAX_PATH_DEPTH = 12;

const NATIVE_VIEWS = {
  full: { outputType: "mermaid", args: [] },
  src: { outputType: "mermaid", args: ["-I", "^src/"] },
  "public-api": {
    outputType: "mermaid",
    args: ["-F", "^src/index.ts$", "--focus-depth", "8", "-x", "^tests/"]
  },
  executor: { outputType: "mermaid", args: ["-R", "^src/executor.ts$"] },
  types: { outputType: "mermaid", args: ["-R", "^src/types.ts$"] },
  report: { outputType: "err-long", args: [] },
  json: { outputType: "json", args: [] }
};

const CUSTOM_VIEWS = new Set(["local", "api-paths", "test-paths", "summary"]);

function printHelp() {
  process.stdout.write(`Usage:
  npm run arch:deps -- [options]

Defaults:
  - Outputs Mermaid to stdout
  - Equivalent to: npm run arch:deps -- --view full

Options:
  --view <name>         View preset to output
  --focus <regex>       depcruise focus regex
  --focus-depth <n>     depcruise focus depth
  --reaches <regex>     depcruise reaches regex
  --include-only <re>   depcruise include-only regex
  --exclude <regex>     depcruise exclude regex
  --output-type <type>  Override depcruise output type for native views
  --help                Show this help

Views (native):
  full | src | public-api | executor | types | report | json

Views (custom, computed in-memory):
  local      Mermaid graph of deduplicated local edges (src/tests only)
  api-paths  Mermaid dependency paths from src/index.ts
  test-paths Mermaid dependency paths from tests/*.test.ts
  summary    Markdown architecture summary
`);
}

function parseArgs(argv) {
  const parsed = {
    view: "full",
    outputType: undefined,
    depcruiseArgs: []
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--view") {
      parsed.view = argv[++i];
      continue;
    }
    if (arg === "--output-type") {
      parsed.outputType = argv[++i];
      continue;
    }
    if (arg === "--focus") {
      parsed.depcruiseArgs.push("-F", argv[++i]);
      continue;
    }
    if (arg === "--focus-depth") {
      parsed.depcruiseArgs.push("--focus-depth", argv[++i]);
      continue;
    }
    if (arg === "--reaches") {
      parsed.depcruiseArgs.push("-R", argv[++i]);
      continue;
    }
    if (arg === "--include-only") {
      parsed.depcruiseArgs.push("-I", argv[++i]);
      continue;
    }
    if (arg === "--exclude") {
      parsed.depcruiseArgs.push("-x", argv[++i]);
      continue;
    }

    // Pass-through for advanced depcruise flags.
    parsed.depcruiseArgs.push(arg);
  }

  return parsed;
}

function normalizeModulePath(value) {
  return value.replace(/\\/g, "/");
}

function isLocalModule(value) {
  return value.startsWith("src/") || value.startsWith("tests/");
}

function toSortedArray(setOrIterable) {
  return Array.from(setOrIterable).sort();
}

async function runDepcruise(args, outputType) {
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const finalArgs = ["depcruise", ...TARGETS, "-c", CONFIG_FILE, "-T", outputType, ...args];
  const { stdout, stderr } = await execFile(command, finalArgs, {
    cwd: process.cwd(),
    maxBuffer: 32 * 1024 * 1024
  });

  if (stderr && stderr.trim()) {
    process.stderr.write(`${stderr}\n`);
  }

  return stdout;
}

function buildLocalGraph(cruiseJson) {
  const nodes = new Set();
  const adjacency = new Map();
  const reverse = new Map();

  for (const moduleInfo of cruiseJson.modules ?? []) {
    const source = normalizeModulePath(moduleInfo.source ?? "");
    if (!isLocalModule(source)) {
      continue;
    }
    nodes.add(source);
    adjacency.set(source, new Set());
    reverse.set(source, new Set());
  }

  for (const moduleInfo of cruiseJson.modules ?? []) {
    const source = normalizeModulePath(moduleInfo.source ?? "");
    if (!nodes.has(source)) {
      continue;
    }
    for (const dependency of moduleInfo.dependencies ?? []) {
      const resolved = normalizeModulePath(dependency.resolved ?? "");
      if (!nodes.has(resolved)) {
        continue;
      }
      adjacency.get(source).add(resolved);
      reverse.get(resolved).add(source);
    }
  }

  return {
    nodes: new Set(Array.from(nodes).sort()),
    adjacency: new Map(
      Array.from(adjacency.entries()).map(([from, toSet]) => [
        from,
        new Set(Array.from(toSet).sort())
      ])
    ),
    reverse: new Map(
      Array.from(reverse.entries()).map(([to, fromSet]) => [to, new Set(Array.from(fromSet).sort())])
    )
  };
}

function rootsOf(graph) {
  return toSortedArray(graph.nodes).filter((node) => (graph.reverse.get(node)?.size ?? 0) === 0);
}

function leavesOf(graph) {
  return toSortedArray(graph.nodes).filter((node) => (graph.adjacency.get(node)?.size ?? 0) === 0);
}

function enumeratePaths({ graph, starts, maxDepth = MAX_PATH_DEPTH, includeNode }) {
  const paths = [];

  const walk = (node, trail, seen) => {
    if (trail.length > maxDepth) {
      paths.push([...trail]);
      return;
    }

    const nextNodes = toSortedArray(graph.adjacency.get(node) ?? []).filter((next) =>
      includeNode ? includeNode(next) : true
    );

    if (nextNodes.length === 0) {
      paths.push([...trail]);
      return;
    }

    let traversed = false;
    for (const next of nextNodes) {
      if (seen.has(next)) {
        continue;
      }
      traversed = true;
      seen.add(next);
      trail.push(next);
      walk(next, trail, seen);
      trail.pop();
      seen.delete(next);
    }

    if (!traversed) {
      paths.push([...trail]);
    }
  };

  for (const start of starts) {
    if (!graph.nodes.has(start)) {
      continue;
    }
    const trail = [start];
    walk(start, trail, new Set(trail));
  }

  return paths;
}

function toEdgePairsFromGraph(graph) {
  const edges = [];
  for (const from of toSortedArray(graph.nodes)) {
    for (const to of toSortedArray(graph.adjacency.get(from) ?? [])) {
      edges.push([from, to]);
    }
  }
  return edges;
}

function toEdgePairsFromPaths(paths) {
  const edges = new Set();
  for (const pathNodes of paths) {
    for (let i = 0; i < pathNodes.length - 1; i++) {
      edges.add(`${pathNodes[i]}=>${pathNodes[i + 1]}`);
    }
  }
  return toSortedArray(edges).map((value) => value.split("=>"));
}

function escapeMermaidLabel(value) {
  return value.replace(/"/g, '\\"');
}

function summarizePaths(paths) {
  return paths.map((pathNodes, index) => `${String(index + 1).padStart(2, "0")}. ${pathNodes.join(" -> ")}`);
}

function dedupePaths(paths, keyFn) {
  const deduped = [];
  const seen = new Set();

  for (const pathNodes of paths) {
    const key = keyFn(pathNodes);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(pathNodes);
  }

  return deduped;
}

function renderMermaid({ title, nodes, edges, entryNodes = [], pathComments = [] }) {
  const sortedNodes = Array.from(nodes).sort();
  const sortedEdges = [...edges].sort((a, b) =>
    `${a[0]}=>${a[1]}`.localeCompare(`${b[0]}=>${b[1]}`)
  );
  const idMap = new Map(sortedNodes.map((node, index) => [node, `N${index}`]));

  const lines = [];
  lines.push("flowchart TD");
  lines.push("");
  lines.push(`%% ${title}`);
  for (const comment of pathComments) {
    lines.push(`%% ${comment}`);
  }
  if (pathComments.length > 0) {
    lines.push("");
  }

  for (const node of sortedNodes) {
    lines.push(`${idMap.get(node)}["${escapeMermaidLabel(node)}"]`);
  }

  if (sortedNodes.length > 0) {
    lines.push("");
  }

  for (const [from, to] of sortedEdges) {
    lines.push(`${idMap.get(from)} --> ${idMap.get(to)}`);
  }

  const leaves = sortedNodes.filter((node) => !sortedEdges.some(([from]) => from === node));
  const validEntries = entryNodes.filter((node) => idMap.has(node));

  if (validEntries.length > 0 || leaves.length > 0) {
    lines.push("");
    lines.push("classDef entry fill:#cfe9ff,stroke:#0b5ea6,color:#111;");
    lines.push("classDef leaf fill:#d8f8d0,stroke:#2b7f2a,color:#111;");
  }
  if (validEntries.length > 0) {
    lines.push(`class ${validEntries.map((node) => idMap.get(node)).join(",")} entry;`);
  }
  if (leaves.length > 0) {
    lines.push(`class ${leaves.map((node) => idMap.get(node)).join(",")} leaf;`);
  }

  lines.push("");
  return lines.join("\n");
}

function renderSummary(graph, apiPaths, testPaths) {
  const nodes = toSortedArray(graph.nodes);
  const rows = nodes.map((modulePath) => ({
    module: modulePath,
    deps: toSortedArray(graph.adjacency.get(modulePath) ?? []),
    dependents: toSortedArray(graph.reverse.get(modulePath) ?? []),
    fanOut: graph.adjacency.get(modulePath)?.size ?? 0,
    fanIn: graph.reverse.get(modulePath)?.size ?? 0
  }));

  const topHubs = [...rows].sort((a, b) => b.fanIn + b.fanOut - (a.fanIn + a.fanOut)).slice(0, 8);
  const roots = rootsOf(graph);
  const leaves = leavesOf(graph);

  const lines = [];
  lines.push("# Dependency Architecture Summary");
  lines.push("");
  lines.push(`- Modules: ${nodes.length}`);
  lines.push(`- Roots: ${roots.length > 0 ? roots.join(", ") : "none"}`);
  lines.push(`- Leaves: ${leaves.length > 0 ? leaves.join(", ") : "none"}`);
  lines.push("");
  lines.push("## Most Connected Modules");
  lines.push("");
  lines.push("| Module | Fan-in | Fan-out |");
  lines.push("|---|---:|---:|");
  for (const row of topHubs) {
    lines.push(`| \`${row.module}\` | ${row.fanIn} | ${row.fanOut} |`);
  }

  lines.push("");
  lines.push("## Module Reference");
  lines.push("");
  lines.push("| Module | Direct dependencies | Direct dependents |");
  lines.push("|---|---|---|");
  for (const row of rows) {
    const deps = row.deps.length > 0 ? row.deps.map((d) => `\`${d}\``).join(", ") : "none";
    const dependents = row.dependents.length > 0
      ? row.dependents.map((d) => `\`${d}\``).join(", ")
      : "none";
    lines.push(`| \`${row.module}\` | ${deps} | ${dependents} |`);
  }

  lines.push("");
  lines.push("## Public API Dependency Paths");
  lines.push("");
  for (const line of summarizePaths(apiPaths)) {
    lines.push(`- ${line}`);
  }

  lines.push("");
  lines.push("## Test Dependency Paths");
  lines.push("");
  for (const line of summarizePaths(testPaths)) {
    lines.push(`- ${line}`);
  }
  lines.push("");

  return lines.join("\n");
}

async function renderCustomView(view, depcruiseArgs) {
  const jsonOutput = await runDepcruise(depcruiseArgs, "json");
  const graph = buildLocalGraph(JSON.parse(jsonOutput));

  if (view === "local") {
    return renderMermaid({
      title: "Local dependency graph (deduplicated)",
      nodes: graph.nodes,
      edges: toEdgePairsFromGraph(graph),
      entryNodes: rootsOf(graph)
    });
  }

  if (view === "api-paths") {
    const apiPaths = enumeratePaths({
      graph,
      starts: ["src/index.ts"],
      includeNode: (node) => node.startsWith("src/")
    });
    return renderMermaid({
      title: "Dependency paths from public API",
      nodes: new Set(apiPaths.flat()),
      edges: toEdgePairsFromPaths(apiPaths),
      entryNodes: ["src/index.ts"],
      pathComments: summarizePaths(apiPaths)
    });
  }

  const testEntries = rootsOf(graph).filter((node) => node.startsWith("tests/"));
  const rawTestPaths = enumeratePaths({ graph, starts: testEntries });
  const testPaths = dedupePaths(
    rawTestPaths.map((pathNodes) => [
      pathNodes[0].replace(/^tests\/[^/]+[.]test[.]ts$/, "tests/*.test.ts"),
      ...pathNodes.slice(1)
    ]),
    (pathNodes) => pathNodes.join("=>")
  );

  if (view === "test-paths") {
    return renderMermaid({
      title: "Dependency paths from test entry points",
      nodes: new Set(rawTestPaths.flat()),
      edges: toEdgePairsFromPaths(rawTestPaths),
      entryNodes: testEntries,
      pathComments: summarizePaths(testPaths)
    });
  }

  if (view === "summary") {
    const apiPaths = enumeratePaths({
      graph,
      starts: ["src/index.ts"],
      includeNode: (node) => node.startsWith("src/")
    });
    return renderSummary(graph, apiPaths, testPaths);
  }

  throw new Error(`Unknown custom view '${view}'`);
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.help) {
    printHelp();
    return;
  }

  if (!parsed.view) {
    throw new Error("Missing value for --view");
  }

  if (NATIVE_VIEWS[parsed.view]) {
    const preset = NATIVE_VIEWS[parsed.view];
    const outputType = parsed.outputType ?? preset.outputType;
    const output = await runDepcruise([...preset.args, ...parsed.depcruiseArgs], outputType);
    process.stdout.write(output);
    return;
  }

  if (CUSTOM_VIEWS.has(parsed.view)) {
    const output = await renderCustomView(parsed.view, parsed.depcruiseArgs);
    process.stdout.write(output);
    return;
  }

  throw new Error(
    `Unknown --view '${parsed.view}'. Use --help to list supported view names.`
  );
}

main().catch((error) => {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  process.stderr.write(`arch:deps failed.\n${message}\n`);
  process.exitCode = 1;
});
