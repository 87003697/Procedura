import type {
  CsgResult,
  CustomizeRequest,
  CustomizeResponse,
  DirListing,
  GenerateRequest,
  JobDetail,
  JobEvent,
  JobRecord,
  ParamsResponse,
  PartsResponse,
  RunDetail,
  RunsResponse,
  ServerInfo,
  TrajectoryData,
  UploadResponse,
} from "../shared/types.ts";

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, signal ? { signal } : undefined);
  if (!res.ok) {
    let detail = "";
    try {
      detail = ((await res.json()) as { error?: string }).error ?? "";
    } catch {
      /* ignore */
    }
    throw new Error(detail || `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export const api = {
  info: (signal?: AbortSignal) => getJson<ServerInfo>("/api/info", signal),
  runs: (signal?: AbortSignal) => getJson<RunsResponse>("/api/runs", signal),
  run: (id: string, signal?: AbortSignal) =>
    getJson<RunDetail>(`/api/run?id=${encodeURIComponent(id)}`, signal),
  trajectory: (id: string, file?: string, signal?: AbortSignal) =>
    getJson<TrajectoryData>(
      `/api/trajectory?id=${encodeURIComponent(id)}${file ? `&file=${encodeURIComponent(file)}` : ""}`,
      signal,
    ),
  ls: (id: string, sub: string, signal?: AbortSignal) =>
    getJson<DirListing>(
      `/api/ls?id=${encodeURIComponent(id)}&sub=${encodeURIComponent(sub)}`,
      signal,
    ),
  jobs: (signal?: AbortSignal) =>
    getJson<{ jobs: JobRecord[]; generation: boolean }>("/api/jobs", signal),
  job: (id: string, signal?: AbortSignal) =>
    getJson<JobDetail>(`/api/job?id=${encodeURIComponent(id)}`, signal),
  generate: async (body: GenerateRequest): Promise<JobRecord> => {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = ((await res.json()) as { error?: string }).error ?? "";
      } catch {
        /* ignore */
      }
      throw new Error(detail || `${res.status} ${res.statusText}`);
    }
    return (await res.json()) as JobRecord;
  },
  /** Stage a reference image; the returned path goes into GenerateRequest.imagePath. */
  upload: async (file: File): Promise<UploadResponse> => {
    const form = new FormData();
    form.append("file", file, file.name);
    const res = await fetch("/api/upload", { method: "POST", body: form });
    if (!res.ok) {
      let detail = "";
      try {
        detail = ((await res.json()) as { error?: string }).error ?? "";
      } catch {
        /* ignore */
      }
      throw new Error(detail || `${res.status} ${res.statusText}`);
    }
    return (await res.json()) as UploadResponse;
  },
  cancelJob: async (id: string): Promise<void> => {
    await fetch(`/api/jobs/cancel?id=${encodeURIComponent(id)}`, { method: "POST" });
  },
  params: (id: string, which: string, signal?: AbortSignal) =>
    getJson<ParamsResponse>(
      `/api/params?id=${encodeURIComponent(id)}&which=${encodeURIComponent(which)}`,
      signal,
    ),
  parts: (id: string, which: string, signal?: AbortSignal) =>
    getJson<PartsResponse>(
      `/api/parts?id=${encodeURIComponent(id)}&which=${encodeURIComponent(which)}`,
      signal,
    ),
  csg: async (
    body: { id: string; which: string; overrides: Record<string, number | boolean | string> },
    signal?: AbortSignal,
  ): Promise<CsgResult> => {
    const res = await fetch("/api/csg", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = ((await res.json()) as { error?: string }).error ?? "";
      } catch {
        /* ignore */
      }
      throw new Error(detail || `${res.status} ${res.statusText}`);
    }
    return (await res.json()) as CsgResult;
  },
  customize: async (body: CustomizeRequest, signal?: AbortSignal): Promise<CustomizeResponse> => {
    const res = await fetch("/api/customize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = ((await res.json()) as { error?: string }).error ?? "";
      } catch {
        /* ignore */
      }
      throw new Error(detail || `${res.status} ${res.statusText}`);
    }
    return (await res.json()) as CustomizeResponse;
  },
};

/** Subscribe to a job's live event stream (SSE). Returns an unsubscribe fn. */
export function subscribeJob(id: string, onEvent: (ev: JobEvent) => void): () => void {
  const es = new EventSource(`/api/jobs/stream?id=${encodeURIComponent(id)}`);
  es.onmessage = (e) => {
    try {
      onEvent(JSON.parse(e.data) as JobEvent);
    } catch {
      /* ignore malformed frame */
    }
  };
  // The server closes the stream once a job is terminal; without this the
  // EventSource would auto-reconnect in a loop (reconnect storm).
  es.onerror = () => es.close();
  return () => es.close();
}

/** URL for a raw artifact file (relative path under the runs root). A `?v=…`
 *  cache-buster on the path becomes its own query param, never part of the
 *  file path the server resolves. */
export function fileUrl(path: string): string {
  const [p, q] = path.split("?") as [string, string | undefined];
  return `/api/file?path=${encodeURIComponent(p)}${q ? `&${q}` : ""}`;
}

/** URL that forces a download (Content-Disposition: attachment). */
export function downloadUrl(path: string): string {
  return `/api/file?path=${encodeURIComponent(path)}&download=1`;
}

/** Fetch a text artifact (scad / txt / json), returning its body. */
export async function fetchText(path: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(fileUrl(path), signal ? { signal } : undefined);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}
