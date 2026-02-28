import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

async function main() {
  await run("npm", ["run", "build"], repoRoot);
  const tarballName = (await run("npm", ["pack", "--silent"], repoRoot)).trim().split(/\r?\n/).pop();

  if (!tarballName) {
    throw new Error("npm pack did not produce a tarball name");
  }

  const tarballPath = path.join(repoRoot, tarballName);
  const tempDir = await mkdtemp(path.join(tmpdir(), "ts-agent-lib-pack-smoke-"));

  try {
    const copiedTarball = path.join(tempDir, tarballName);
    await copyFile(tarballPath, copiedTarball);

    await writeFile(
      path.join(tempDir, "package.json"),
      JSON.stringify(
        {
          name: "ts-agent-lib-pack-smoke",
          private: true,
          type: "module",
          dependencies: {
            "ts-agent-lib": `./${tarballName}`
          }
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    await writeFile(
      path.join(tempDir, "index.mjs"),
      [
        'import { DagExecutor, PlanBuilder, StepStatus } from "ts-agent-lib";',
        "",
        "const builder = new PlanBuilder();",
        'builder.addStep({ id: "a", action: "noop" });',
        "const plan = builder.build();",
        "",
        "const executor = new DagExecutor();",
        "const state = await executor.executeAsync(plan, {",
        '  noop: async (step) => ({ stepId: step.id, status: StepStatus.COMPLETED })',
        "});",
        "",
        'if (state.status !== "completed") {',
        '  throw new Error(`unexpected execution status: ${state.status}`);',
        "}",
        'console.log("pack smoke check passed");',
        ""
      ].join("\n"),
      "utf8"
    );

    await run("npm", ["install", "--silent"], tempDir);
    await run("node", ["index.mjs"], tempDir);
  } finally {
    await unlink(tarballPath).catch(() => undefined);
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd }, (error, stdout, stderr) => {
      if (stdout.trim()) {
        process.stdout.write(stdout);
      }
      if (stderr.trim()) {
        process.stderr.write(stderr);
      }
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
