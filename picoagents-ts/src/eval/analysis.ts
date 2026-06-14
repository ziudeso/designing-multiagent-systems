/**
 * Evaluation analysis utilities.
 *
 * Functions for analyzing and displaying evaluation results as formatted console
 * tables. Ported from Python `eval/_analysis.py`.
 */

import { EvalResults } from "./results.js";

/** Left-pad (right-align) a string to a given width. */
function padStart(s: string, width: number): string {
  return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

/** Right-pad (left-align) a string to a given width. */
function padEnd(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/** Format an integer with thousands separators (locale-independent). */
function withCommas(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function signed(n: number, digits: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}`;
}

/** Format results as a summary table. */
export function formatSummaryTable(results: EvalResults, baseline?: string): string {
  const summaries = results.getSummaries();
  const comparison = results.compareTargets(baseline);

  if (!Object.keys(summaries).length) return "No results to display.";

  const lines: string[] = [
    `Evaluation: ${results.datasetName} (${results.taskIds.length} tasks)`,
    `Run ID: ${results.runId}`,
    `Date: ${formatDate(results.timestamp)}`,
    "=".repeat(80),
    ""
  ];

  const header =
    `${padEnd("Target", 20)} ${padStart("Score", 8)} ${padStart("Tokens", 12)} ` +
    `${padStart("Iters", 8)} ${padStart("Duration", 10)} ${padStart("Files", 8)} ${padStart("Dupes", 8)}`;
  lines.push(header);
  lines.push("-".repeat(80));

  for (const targetName of results.targetNames) {
    const summary = summaries[targetName];
    if (!summary) continue;
    const comp = comparison[targetName] ?? {};

    const scoreStr = summary.avgScore.toFixed(1);
    let tokensStr = withCommas(summary.totalTokens);
    const itersStr = String(summary.totalIterations);
    const durationStr = `${(summary.totalDurationMs / 1000).toFixed(1)}s`;
    const filesStr = String(summary.totalUniqueFiles);
    const dupesStr = String(summary.totalDuplicateReads);

    if (!comp.is_baseline) {
      const tokenPct = (comp.token_diff_pct as number) ?? 0;
      if (tokenPct !== 0) tokensStr += ` (${signed(tokenPct, 0)}%)`;
    }

    lines.push(
      `${padEnd(targetName, 20)} ${padStart(scoreStr, 8)} ${padStart(tokensStr, 12)} ` +
        `${padStart(itersStr, 8)} ${padStart(durationStr, 10)} ${padStart(filesStr, 8)} ${padStart(dupesStr, 8)}`
    );
  }

  lines.push("");

  if (baseline && results.targetNames.length > 1) {
    lines.push(`vs ${baseline || results.targetNames[0]}:`);
    for (const targetName of results.targetNames) {
      const comp = comparison[targetName] ?? {};
      if (comp.is_baseline) continue;
      const tokenDiff = (comp.token_diff_pct as number) ?? 0;
      const scoreDiff = (comp.score_diff as number) ?? 0;
      const iterDiff = (comp.iteration_diff_pct as number) ?? 0;
      lines.push(
        `  ${targetName}: ` +
          `${signed(tokenDiff, 1)}% tokens, ` +
          `${signed(iterDiff, 1)}% iters, ` +
          `${signed(scoreDiff, 2)} score`
      );
    }
  }

  return lines.join("\n");
}

/** Format a per-task breakdown. */
export function formatTaskBreakdown(results: EvalResults): string {
  const lines: string[] = ["Per-Task Breakdown", "=".repeat(80), ""];

  let header = padEnd("Task", 25);
  for (const targetName of results.targetNames) {
    header += ` ${padStart(targetName.slice(0, 15), 15)}`;
  }
  lines.push(header);
  lines.push("-".repeat(80));

  for (const taskId of results.taskIds) {
    lines.push(`\n${taskId}`);

    let tokensRow = `  ${padEnd("tokens", 23)}`;
    for (const targetName of results.targetNames) {
      const result = results.getResult(targetName, taskId);
      tokensRow += ` ${padStart(result ? withCommas(result.totalTokens) : "-", 15)}`;
    }
    lines.push(tokensRow);

    let scoreRow = `  ${padEnd("score", 23)}`;
    for (const targetName of results.targetNames) {
      const result = results.getResult(targetName, taskId);
      scoreRow += ` ${padStart(result ? result.score.overall.toFixed(1) : "-", 15)}`;
    }
    lines.push(scoreRow);

    let iterRow = `  ${padEnd("iterations", 23)}`;
    for (const targetName of results.targetNames) {
      const result = results.getResult(targetName, taskId);
      iterRow += ` ${padStart(result ? String(result.iterations) : "-", 15)}`;
    }
    lines.push(iterRow);
  }

  return lines.join("\n");
}

/** Format a file-read pattern analysis. */
export function formatFileReadAnalysis(results: EvalResults): string {
  const lines: string[] = ["File Read Analysis", "=".repeat(80), ""];

  for (const targetName of results.targetNames) {
    lines.push(`\n${targetName.toUpperCase()}`);
    lines.push("-".repeat(40));

    const allReads: Record<string, number> = {};
    for (const taskId of results.taskIds) {
      const result = results.getResult(targetName, taskId);
      if (!result) continue;
      for (const [p, count] of Object.entries(result.filesRead)) {
        allReads[p] = (allReads[p] ?? 0) + count;
      }
    }

    if (!Object.keys(allReads).length) {
      lines.push("  No file reads recorded");
      continue;
    }

    const sortedReads = Object.entries(allReads).sort((a, b) => b[1] - a[1]);

    for (const [p, count] of sortedReads.slice(0, 20)) {
      let displayPath = p;
      if (p.length > 45) displayPath = `...${p.slice(-42)}`;
      const bar = "#".repeat(Math.min(count, 20));
      const marker = count > 1 ? " !!" : "";
      lines.push(`  ${padStart(String(count), 3)}x ${padEnd(displayPath, 45)} ${bar}${marker}`);
    }

    if (sortedReads.length > 20) {
      lines.push(`  ... and ${sortedReads.length - 20} more files`);
    }

    const total = Object.values(allReads).reduce((a, b) => a + b, 0);
    const unique = Object.keys(allReads).length;
    const duplicates = total - unique;
    lines.push(`\n  Total: ${total} reads, ${unique} unique files`);
    if (duplicates > 0) {
      const overhead = (duplicates / total) * 100;
      lines.push(`  Duplicate reads: ${duplicates} (${overhead.toFixed(0)}% overhead)`);
    }
  }

  return lines.join("\n");
}

/** Format token growth across iterations for a single task. */
export function formatTokenGrowth(results: EvalResults, taskId?: string): string {
  let id = taskId;
  if (!id && results.taskIds.length) id = results.taskIds[0];
  if (!id) return "No tasks to analyze.";

  const lines: string[] = [`Token Growth: ${id}`, "=".repeat(80), ""];

  for (const targetName of results.targetNames) {
    const result = results.getResult(targetName, id);
    if (!result) continue;

    lines.push(`\n${targetName}:`);

    const tokenGrowth = (result.metrics.token_growth as Array<[number, number]>) ?? [];
    if (!tokenGrowth.length) {
      lines.push("  No iteration data available");
      continue;
    }

    const maxTokens = tokenGrowth.length ? Math.max(...tokenGrowth.map((t) => t[1])) : 1;
    for (const [idx, tokens] of tokenGrowth.slice(0, 15)) {
      const barLen = Math.floor((tokens / (maxTokens || 1)) * 30);
      const bar = "#".repeat(barLen);
      lines.push(`  ${padStart(String(idx), 2)}: ${padStart(withCommas(tokens), 6)} ${bar}`);
    }

    if (tokenGrowth.length > 15) {
      lines.push(`  ... (${tokenGrowth.length - 15} more iterations)`);
    }
  }

  return lines.join("\n");
}

export interface PrintResultsOptions {
  baseline?: string;
  showTaskBreakdown?: boolean;
  showFileAnalysis?: boolean;
  showTokenGrowth?: boolean;
}

/** Print formatted evaluation results to the console. */
export function printResults(results: EvalResults, options: PrintResultsOptions = {}): void {
  const showTaskBreakdown = options.showTaskBreakdown ?? true;
  const showFileAnalysis = options.showFileAnalysis ?? false;
  const showTokenGrowth = options.showTokenGrowth ?? false;

  console.log(formatSummaryTable(results, options.baseline));

  if (showTaskBreakdown) {
    console.log("\n");
    console.log(formatTaskBreakdown(results));
  }
  if (showFileAnalysis) {
    console.log("\n");
    console.log(formatFileReadAnalysis(results));
  }
  if (showTokenGrowth) {
    console.log("\n");
    console.log(formatTokenGrowth(results));
  }
}
