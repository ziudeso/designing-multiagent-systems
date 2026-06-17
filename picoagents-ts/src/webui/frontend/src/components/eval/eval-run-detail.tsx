/**
 * EvalRunDetail — results matrix, progress bar, and per-result drilldown.
 */

import { useState, useEffect, useCallback } from "react";
import { StatusBadge, ScoreBadge } from "@/components/eval/score-badge";
import { evalApiClient } from "@/services/eval-api";
import {
  Clock,
  Zap,
  CheckCircle,
  XCircle,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import type { EvalRun, EvalResult } from "@/types/eval";

interface EvalRunDetailProps {
  evalRun: EvalRun;
}

export function EvalRunDetail({ evalRun }: EvalRunDetailProps) {
  const [results, setResults] = useState<EvalResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedResult, setExpandedResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await evalApiClient.getEvalResults(evalRun.id);
      setResults(data);
    } catch (e) {
      console.error("Failed to load results:", e);
    } finally {
      setLoading(false);
    }
  }, [evalRun.id]);

  useEffect(() => {
    load();
  }, [load]);

  // Reload when eval run completes
  useEffect(() => {
    if (evalRun.status === "running" || evalRun.status === "pending") {
      const interval = setInterval(load, 3000);
      return () => clearInterval(interval);
    }
  }, [evalRun.status, load]);

  // Compute summary stats
  const avgScore =
    results.length > 0
      ? results.reduce((s, r) => s + r.overallScore, 0) / results.length
      : 0;
  const successCount = results.filter((r) => r.success).length;
  const totalDuration = results.reduce((s, r) => s + r.durationMs, 0);
  const totalTokens = results.reduce((s, r) => s + r.totalTokens, 0);

  // Group results by target
  const byTarget = new Map<string, EvalResult[]>();
  for (const r of results) {
    const arr = byTarget.get(r.targetName) || [];
    arr.push(r);
    byTarget.set(r.targetName, arr);
  }

  return (
    <div className="p-4 space-y-4">
      {/* Run metadata */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="text-base font-semibold">{evalRun.datasetName}</h3>
          <StatusBadge status={evalRun.status} />
        </div>

        {/* Progress bar */}
        {(evalRun.status === "running" || evalRun.status === "pending") && (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {evalRun.completedTasks}/{evalRun.totalTasks} tasks
              </span>
              {evalRun.currentTarget && (
                <span>Target: {evalRun.currentTarget}</span>
              )}
              {evalRun.currentTask && (
                <span>Task: {evalRun.currentTask}</span>
              )}
            </div>
            <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all duration-500"
                style={{
                  width: `${evalRun.totalTasks > 0 ? (evalRun.completedTasks / evalRun.totalTasks) * 100 : 0}%`,
                }}
              />
            </div>
          </div>
        )}

        {/* Summary stats */}
        {results.length > 0 && (
          <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
            <span className="flex items-center gap-1">
              Avg Score: <ScoreBadge score={avgScore} />
            </span>
            <span className="flex items-center gap-1">
              <CheckCircle className="h-3 w-3 text-green-500" />
              {successCount}/{results.length} passed
            </span>
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {(totalDuration / 1000).toFixed(1)}s total
            </span>
            <span className="flex items-center gap-1">
              <Zap className="h-3 w-3" />
              {totalTokens.toLocaleString()} tokens
            </span>
            <span>
              Targets: {evalRun.targetNames?.join(", ")}
            </span>
          </div>
        )}

        {evalRun.errorMessage && (
          <p className="text-xs text-destructive bg-destructive/10 p-2 rounded">
            {evalRun.errorMessage}
          </p>
        )}
      </div>

      {/* Results by target */}
      {loading ? (
        <div className="p-4 text-sm text-muted-foreground text-center">
          Loading results...
        </div>
      ) : results.length === 0 ? (
        <div className="p-4 text-sm text-muted-foreground text-center">
          {evalRun.status === "running"
            ? "Waiting for results..."
            : "No results."}
        </div>
      ) : (
        Array.from(byTarget.entries()).map(([targetName, targetResults]) => (
          <TargetResultsSection
            key={targetName}
            targetName={targetName}
            results={targetResults}
            expandedResult={expandedResult}
            onToggle={(id) =>
              setExpandedResult(expandedResult === id ? null : id)
            }
          />
        ))
      )}
    </div>
  );
}

function TargetResultsSection({
  targetName,
  results,
  expandedResult,
  onToggle,
}: {
  targetName: string;
  results: EvalResult[];
  expandedResult: string | null;
  onToggle: (id: string) => void;
}) {
  const avgScore =
    results.reduce((s, r) => s + r.overallScore, 0) / results.length;
  const successCount = results.filter((r) => r.success).length;

  return (
    <div className="border rounded-lg">
      <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/30">
        <h4 className="text-xs font-medium flex-1">{targetName}</h4>
        <ScoreBadge score={avgScore} />
        <span className="text-xs text-muted-foreground">
          {successCount}/{results.length} passed
        </span>
      </div>
      <div className="divide-y">
        {results.map((result) => (
          <ResultRow
            key={result.id}
            result={result}
            expanded={expandedResult === result.id}
            onToggle={() => onToggle(result.id)}
          />
        ))}
      </div>
    </div>
  );
}

function ResultRow({
  result,
  expanded,
  onToggle,
}: {
  result: EvalResult;
  expanded: boolean;
  onToggle: () => void;
}) {
  const dur =
    result.durationMs >= 1000
      ? `${(result.durationMs / 1000).toFixed(1)}s`
      : `${result.durationMs}ms`;

  return (
    <div>
      <div
        className="flex items-center gap-3 px-3 py-2 hover:bg-muted/30 cursor-pointer"
        onClick={onToggle}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            {result.success ? (
              <CheckCircle className="h-3.5 w-3.5 text-green-500 shrink-0" />
            ) : (
              <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />
            )}
            <span className="text-sm truncate">{result.taskId}</span>
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs text-muted-foreground shrink-0">
          <ScoreBadge score={result.overallScore} />
          <span>{dur}</span>
          <span>{result.totalTokens.toLocaleString()} tok</span>
          {expanded ? (
            <ChevronUp className="h-3 w-3" />
          ) : (
            <ChevronDown className="h-3 w-3" />
          )}
        </div>
      </div>

      {expanded && (
        <div className="px-3 py-2 bg-muted/20 border-t space-y-2">
          {/* Dimensions */}
          {result.dimensions &&
            Object.keys(result.dimensions).length > 0 && (
              <div>
                <p className="text-xs font-medium mb-1">Score Dimensions</p>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(result.dimensions).map(([key, val]) => (
                    <div
                      key={key}
                      className="flex items-center gap-1.5 text-xs"
                    >
                      <span className="text-muted-foreground">{key}:</span>
                      <ScoreBadge score={val} />
                    </div>
                  ))}
                </div>
              </div>
            )}

          {/* Reasoning */}
          {result.reasoning &&
            Object.keys(result.reasoning).length > 0 && (
              <div>
                <p className="text-xs font-medium mb-1">Judge Reasoning</p>
                <div className="space-y-1">
                  {Object.entries(result.reasoning).map(([key, text]) => (
                    <div key={key} className="text-xs">
                      <span className="font-medium text-muted-foreground">
                        {key}:
                      </span>{" "}
                      <span>{text}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

          {/* Error */}
          {result.error && (
            <div className="text-xs text-destructive bg-destructive/10 p-2 rounded">
              {result.error}
            </div>
          )}

          {/* Stats */}
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>{result.iterations} iterations</span>
            <span>{result.toolCalls} tool calls</span>
            <span>
              {result.inputTokens.toLocaleString()} in /{" "}
              {result.outputTokens.toLocaleString()} out
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
