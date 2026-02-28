#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const CONFIG_FILE = ".dependency-cruiser.cjs";
const TARGETS = ["src", "tests"];
const MAX_PATH_DEPTH = 12;

function printHelp() {
  process.stdout.write(`Usage:
  npm run arch -- [options]

Defaults:
  - Outputs ALL Mermaid graphs to stdout
  - Equivalent to: npm run arch -- --graph all

Options:
  --graph <name>        Graph to output (all | callgraph | deps | types)
  --focus <regex>       depcruise focus regex
  --focus-depth <n>     depcruise focus depth
  --reaches <regex>     depcruise reaches regex
  --include-only <re>   depcruise include-only regex
  --exclude <regex>     depcruise exclude regex
  --help                Show this help
`);
}

function parseArgs(argv) {
  const parsed = {
    graph: "all",
    depcruiseArgs: []
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--graph") {
      parsed.graph = argv[++i];
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

async function renderCallgraph(depcruiseArgs) {
  const jsonOutput = await runDepcruise(depcruiseArgs, "json");
  const graph = buildLocalGraph(JSON.parse(jsonOutput));
  const apiPaths = enumeratePaths({
    graph,
    starts: ["src/index.ts"],
    includeNode: (node) => node.startsWith("src/")
  });

  return renderMermaid({
    title: "Callgraph-style dependency paths from public API",
    nodes: new Set(apiPaths.flat()),
    edges: toEdgePairsFromPaths(apiPaths),
    entryNodes: ["src/index.ts"],
    pathComments: summarizePaths(apiPaths)
  });
}

async function renderDeps(depcruiseArgs) {
  return runDepcruise(depcruiseArgs, "mermaid");
}

async function renderTypes(depcruiseArgs) {
  return runDepcruise(["-R", "^src/types.ts$", ...depcruiseArgs], "mermaid");
}

function wrapMermaidSection(title, mermaidText) {
  const trimmed = mermaidText.trim();
  return `## ${title}\n\n\`\`\`mermaid\n${trimmed}\n\`\`\`\n`;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.help) {
    printHelp();
    return;
  }

  if (!parsed.graph) {
    throw new Error("Missing value for --graph");
  }

  const graphName = parsed.graph;
  if (!["all", "callgraph", "deps", "types"].includes(graphName)) {
    throw new Error("Unknown --graph value. Use one of: all, callgraph, deps, types.");
  }

  if (graphName === "callgraph") {
    process.stdout.write(await renderCallgraph(parsed.depcruiseArgs));
    return;
  }
  if (graphName === "deps") {
    process.stdout.write(await renderDeps(parsed.depcruiseArgs));
    return;
  }
  if (graphName === "types") {
    process.stdout.write(await renderTypes(parsed.depcruiseArgs));
    return;
  }

  const [depsMermaid, callgraphMermaid, typesMermaid] = await Promise.all([
    renderDeps(parsed.depcruiseArgs),
    renderCallgraph(parsed.depcruiseArgs),
    renderTypes(parsed.depcruiseArgs)
  ]);

  const output = [
    "# Architecture Graphs",
    "",
    wrapMermaidSection("Deps", depsMermaid),
    wrapMermaidSection("Callgraph", callgraphMermaid),
    wrapMermaidSection("Types", typesMermaid)
  ].join("\n");
  process.stdout.write(output);
}

main().catch((error) => {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  process.stderr.write(`arch failed.\n${message}\n`);
  process.exitCode = 1;
});
