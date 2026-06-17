import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { PicoStore } from "../dist/index.js";
import { makeTempDir } from "./helpers.mjs";

const execFileAsync = promisify(execFile);
const cliPath = path.join(process.cwd(), "dist", "cli.js");

async function runCli(args, options = {}) {
  try {
    const result = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, ...(options.env ?? {}) },
      maxBuffer: 1024 * 1024
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? String(error)
    };
  }
}

function makeStore(storeDir) {
  return new PicoStore({
    dbPath: path.join(storeDir, "picoagents.db"),
    runsDir: path.join(storeDir, "runs"),
    evalDir: path.join(storeDir, "eval")
  });
}

test("unified CLI exposes help, version, and eval list JSON", async () => {
  const dir = await makeTempDir("picoagents-cli-list-");
  const storeDir = path.join(dir, "store");

  const help = await runCli(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /picoagents-ts <command>/);
  assert.match(help.stdout, /eval/);

  const version = await runCli(["--version"]);
  assert.equal(version.code, 0);
  assert.match(version.stdout, /picoagents-ts 0\.1\.0/);

  const list = await runCli(["eval", "list", "--store-dir", storeDir, "--json"]);
  assert.equal(list.code, 0, list.stderr);
  const parsed = JSON.parse(list.stdout);
  assert.deepEqual(parsed.datasets, []);
  assert.deepEqual(parsed.targets, []);
  assert.ok(Array.isArray(parsed.builtinDatasets));
});

test("eval CLI runs a dataset, persists results, and reports stored runs", async () => {
  const dir = await makeTempDir("picoagents-cli-run-");
  const storeDir = path.join(dir, "store");
  const outputDir = path.join(dir, "eval-output");
  const datasetPath = path.join(dir, "dataset.json");
  const configsPath = path.join(dir, "configs.json");

  await writeFile(datasetPath, JSON.stringify({
    name: "cli-dataset",
    version: "1.0.0",
    default_eval_criteria: ["correctness"],
    tasks: [
      {
        id: "task-1",
        name: "Task 1",
        input: "say ok",
        expected_output: "ok",
        eval_criteria: ["correctness"]
      }
    ]
  }, null, 2));
  await writeFile(configsPath, JSON.stringify([
    { name: "static", targetType: "static" }
  ], null, 2));

  const run = await runCli([
    "eval",
    "run",
    datasetPath,
    "--configs",
    configsPath,
    "--judge",
    "exact",
    "--store-dir",
    storeDir,
    "--output",
    outputDir,
    "--baseline",
    "static"
  ]);

  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /Dataset: cli-dataset \(1 tasks\)/);
  assert.match(run.stdout, /Targets: static/);
  assert.match(run.stdout, /Persisted eval run:/);
  assert.match(run.stdout, /static\s+10\.0/);

  const files = await readdir(outputDir);
  assert.equal(files.filter((file) => file.endsWith(".json")).length, 1);

  const store = makeStore(storeDir);
  try {
    const runs = await store.listEvalRuns();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].datasetName, "cli-dataset");
    assert.equal(runs[0].status, "completed");

    const evalResults = await store.getEvalResults(runs[0].id);
    assert.equal(evalResults.length, 1);
    assert.equal(evalResults[0].overallScore, 10);

    const report = await runCli([
      "eval",
      "results",
      runs[0].id,
      "--store-dir",
      storeDir,
      "--show-breakdown"
    ]);
    assert.equal(report.code, 0, report.stderr);
    assert.match(report.stdout, /Evaluation: cli-dataset/);
    assert.match(report.stdout, /Per-Task Breakdown/);
  } finally {
    await store.close();
  }
});
