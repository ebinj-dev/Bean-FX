"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import type { JobView } from "@/lib/types";
import { cn } from "@/lib/utils";

export type JobOutcome =
  | { state: "running" }
  | { state: "completed"; exportId: string; message: string }
  | { state: "failed"; error: string }
  | { state: "cancelled" };

/** Polls a processing job and reports REAL server-side progress. */
export function JobProgressBar({
  jobId,
  label,
  onComplete,
  onFail,
  className,
}: {
  jobId: string;
  label: string;
  onComplete: (exportId: string, message: string) => void;
  onFail: (error: string) => void;
  className?: string;
}) {
  const [job, setJob] = useState<JobView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const doneRef = useRef(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    doneRef.current = false;
    let stopped = false;

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
          onComplete(j.exportId ?? "", j.message ?? "Completed.");
        } else if (j.status === "FAILED" && !doneRef.current) {
          doneRef.current = true;
          stop();
          onFail(j.message ?? "Processing failed.");
        } else if (j.status === "CANCELLED" && !doneRef.current) {
          doneRef.current = true;
          stop();
          onFail("Processing was cancelled. The original media is intact.");
        }
      } catch (err) {
        if (!stopped) setError(err instanceof Error ? err.message : "Status check failed.");
      }
    };

    const stop = () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };

    void poll();
    pollRef.current = setInterval(poll, 700);
    return () => {
      stopped = true;
      stop();
    };
  }, [jobId]);

  const cancel = async () => {
    try {
      await fetch(`/api/jobs/${jobId}`, { method: "DELETE" });
    } catch {
      /* polling will report final state */
    }
  };

  const status = job?.status ?? "QUEUED";
  const running = status === "QUEUED" || status === "PROCESSING";

  return (
    <div className={cn("rounded-lg border border-[#241f10] bg-[#120e05] px-4 py-3.5", className)}>
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.12em] text-[#d4a017]">
          {status === "COMPLETED" ? (
            <CheckCircle2 className="h-4 w-4 text-[#22c55e]" />
          ) : status === "FAILED" || status === "CANCELLED" ? (
            <XCircle className="h-4 w-4 text-[#f87171]" />
          ) : (
            <Loader2 className="h-4 w-4 animate-spin" />
          )}
          {status === "COMPLETED" ? "COMPLETED" : status === "FAILED" ? "FAILED" : status === "CANCELLED" ? "CANCELLED" : label}
        </span>
        {running && (
          <button
            type="button"
            onClick={cancel}
            className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#f87171] hover:underline"
          >
            CANCEL
          </button>
        )}
      </div>
      <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-[#1c1c1c]">
        <div
          className={cn(
            "h-full transition-all duration-500",
            status === "COMPLETED" ? "bg-[#22c55e]" : status === "FAILED" ? "bg-[#ef4444]" : "bg-[#d4a017]"
          )}
          style={{ width: `${job?.progress ?? 0}%` }}
        />
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[10px] text-[#8f8f8a]">
        <span>{job?.stage ?? "Queued"} — progress is reported by the actual ffmpeg encoder</span>
        <span>{job?.progress ?? 0}%</span>
      </div>
      {error && <p className="mt-2 text-[11px] text-[#f87171]">{error}</p>}
    </div>
  );
}
