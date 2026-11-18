/**
 * @beanfx/core — API v1 client + durable job surface (M21 spec §2, §13)
 *
 * Typed client used by the Desktop Bridge, MCP server-side tools and tests.
 * Transport is fetch with `Authorization: Bearer bfx_…` integration tokens
 * (M21 §7) — the SAME auth the server enforces. Versioning: clients send
 * `X-BeanFX-Api-Version`; incompatible servers answer 426 UPGRADE_REQUIRED.
 */
import type { CanonicalProject } from "./project-schema";
import type { JobSubmission, JobView, CapabilityDescriptor } from "./types";
import { COMPAT_WINDOW, CORE_API_VERSION } from "./types";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(`${status} ${code}: ${message}`);
  }
}

export interface BeanFxClientOptions {
  baseUrl: string;
  token: string; // bfx_… integration token
  apiVersion?: string;
  fetchImpl?: typeof fetch;
}

export class BeanFxClient {
  private base: string;
  private token: string;
  private apiVersion: string;
  private f: typeof fetch;

  constructor(opts: BeanFxClientOptions) {
    this.base = opts.baseUrl.replace(/\/$/, "");
    this.token = opts.token;
    this.apiVersion = opts.apiVersion ?? CORE_API_VERSION;
    this.f = opts.fetchImpl ?? fetch;
  }

  private async req<T>(path: string, init?: RequestInit): Promise<{ status: number; data: T }> {
    const res = await this.f(`${this.base}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
        "X-BeanFX-Api-Version": this.apiVersion,
        ...(init?.headers ?? {}),
      },
    });
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
    }
    if (!res.ok) {
      const d = (data ?? {}) as { code?: string; error?: string };
      throw new ApiError(res.status, d.code ?? "error", d.error ?? res.statusText);
    }
    return { status: res.status, data: data as T };
  }

  async capabilities(): Promise<CapabilityDescriptor> {
    const { data } = await this.req<CapabilityDescriptor>("/api/v1/capabilities");
    return data;
  }

  /** Version negotiation per M21 §13 (±1 minor window). */
  assertCompatible(server: CapabilityDescriptor): void {
    if (!server.formatVersions.includes("beanfx-project-v1")) {
      throw new ApiError(426, "UPGRADE_REQUIRED", `server speaks ${server.formatVersions.join(",")}`);
    }
    const minor = Number(this.apiVersion.replace("v", "")) || 1;
    if (minor < 1 + COMPAT_WINDOW.minMinor || minor > 1 + COMPAT_WINDOW.maxMinor) {
      throw new ApiError(426, "UPGRADE_REQUIRED", `client v${minor} outside compatibility window`);
    }
  }

  async listProjects(): Promise<{ projects: Array<{ id: string; name: string; updatedAt: string }> }> {
    const { data } = await this.req<{ projects: Array<{ id: string; name: string; updatedAt: string }> }>("/api/v1/projects");
    return data;
  }

  async exportProject(projectId: string): Promise<CanonicalProject> {
    const { data } = await this.req<{ project: CanonicalProject }>(`/api/v1/projects/${projectId}/canonical`);
    return data.project;
  }

  async submitJob(sub: JobSubmission): Promise<{ job: JobView }> {
    const { data } = await this.req<{ job: JobView }>("/api/v1/jobs", { method: "POST", body: JSON.stringify(sub) });
    return data;
  }

  async job(jobId: string): Promise<JobView> {
    const { data } = await this.req<{ job: JobView }>(`/api/v1/jobs/${jobId}`);
    return data.job;
  }

  async cancelJob(jobId: string): Promise<JobView> {
    const { data } = await this.req<{ job: JobView }>(`/api/v1/jobs/${jobId}`, { method: "DELETE" });
    return data.job;
  }

  /** Poll a job to a terminal state with a deadline. */
  async waitForJob(jobId: string, timeoutMs = 120000, intervalMs = 1000): Promise<JobView> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const j = await this.job(jobId);
      if (["COMPLETED", "FAILED", "CANCELLED"].includes(j.status)) return j;
      if (Date.now() > deadline) throw new ApiError(504, "timeout", `job ${jobId} not terminal after ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}
