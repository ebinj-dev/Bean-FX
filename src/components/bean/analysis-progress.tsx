"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { JobView } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Polls a background RIISHE analysis job (the same job infrastructure the
 * apply flow uses) and reports the server's REAL stage and progress — the
 * pipeline streams its actual 15-stage state into the job record. On
 * completion the full analysis payload is fetched from the result endpoint
 * and handed to the editor; on failure the server's stage-aware error is
 * surfaced verbatim (retry is safe: the original media is untouched and
 * completed transcription chunks are preserved for the next run).
 */
export function AnalysisJobProgress({
  jobId,
  onComplete,
  onFail,
  className,
}: {
  jobId: string;
  onComplete: (result: unknown) => void;
  onFail: (error: string) => void;
  className?: string;
}) {
  const [job, setJob] = useState<JobView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetchingResult, setFetchingResult] = useState(false);
  const doneRef = useRef(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    doneRef.current = false;
    let stopped = false;

    const stop = () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };

    const finish = async () => {
      // The job completed server-side — fetch the stored analysis payload.
      setFetchingResult(true);
      try {
        const res = await fetch(`/api/autocut/analyze/result/${jobId}`);
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.ok) {
          throw new Error((data as { error?: string } | null)?.error ?? `Result fetch failed (${res.status}).`);
        }
        if (!stopped) onComplete(data);
      } catch (err) {
        if (!stopped) onFail(err instanceof Error ? err.message : "Result fetch failed.");
      }
    };

    const poll = async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error ?? `Status check failed (${res.status}).`);
        const j: JobView = data.job;
        if (stopped) return;
        setJob(j);
        if (j.status === "COMPLETED" && !doneRef.current) {
          doneRef.current = true;
          stop();
          void finish();
        } else if (j.status === "FAILED" && !doneRef.current) {
          doneRef.current = true;
          stop();
          onFail(j.message ?? "Analysis failed.");
        } else if (j.status === "CANCELLED" && !doneRef.current) {
          doneRef.current = true;
          stop();
          onFail("Analysis was cancelled. The original media is intact — re-run when ready.");
        }
      } catch (err) {
        if (!stopped) setError(err instanceof Error ? err.message : "Status check failed.");
      }
    };

    void poll();
    pollRef.current = setInterval(poll, 1000);
    return () => {
      stopped = true;
      stop();
    };
  }, [jobId]);

  const status = job?.status ?? "QUEUED";
  const running = status === "QUEUED" || status === "PROCESSING";

  return (
    <div className={cn("rounded-lg border border-[#241f10] bg-[#120e05] px-4 py-3.5", className)}>
      <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.12em] text-[#d4a017]">
        <Loader2 className={cn("h-4 w-4", (running || fetchingResult) && "animate-spin")} />
        {fetchingResult ? "LOADING ANALYSIS RESULT" : "RIISHE ANALYSIS RUNNING"}
      </div>
      <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-[#1c1c1c]">
        <div className="h-full bg-[#d4a017] transition-all duration-500" style={{ width: `${job?.progress ?? 0}%` }} />
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[10px] text-[#8f8f8a]">
        <span>{job?.stage ?? "Queued"} — every stage is reported by the server as it actually runs; you can leave this page without losing the analysis.</span>
        <span>{job?.progress ?? 0}%</span>
      </div>
      {error && <p className="mt-2 text-[11px] text-[#f87171]">{error}</p>}
    </div>
  );
}
