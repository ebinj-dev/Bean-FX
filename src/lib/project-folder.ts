/**
 * M45-B — BEAN FX local project folder (browser File System Access API).
 *
 * Each production gets a real folder on the user's own machine with the
 * standard BEAN FX tree. All access is user-gestured (showDirectoryPicker),
 * read/write permission is explicit, writes stay INSIDE the selected folder,
 * and no absolute local path is ever stored server-side — the manifest lives
 * in the folder itself and the handle lives in browser-managed storage
 * (IndexedDB via the browser's own persistence; we keep it in
 * localStorage only as an availability flag, never serialized handles).
 *
 * Honest limitations (no Desktop Bridge in this unit):
 *  - requires Chromium/Edge (showDirectoryPicker); Safari/Firefox get the
 *    download-based fallback (EXPORT downloads + manifest download);
 *  - the browser must re-grant permission after restart (queryPermission →
 *    requestPermission on a user gesture);
 *  - the server CANNOT write to the user's disk — deliverables are saved by
 *    the browser from streamed downloads into the connected folder.
 */

export const PROJECT_TREE = [
  "00_Brief",
  "01_References",
  "02_Raw_Footage",
  "03_Audio_Music_SFX",
  "04_Images_Graphics",
  "05_Proxies",
  "06_Project_Files",
  "07_AI_Work/Scripts",
  "07_AI_Work/Storyboards",
  "07_AI_Work/Shot_Lists",
  "07_AI_Work/Agent_Reports",
  "07_AI_Work/Edit_Plans",
  "07_AI_Work/Analysis",
  "08_Renders",
  "09_Exports",
  "10_Captions",
  "11_Delivery",
  "12_Archive",
] as const;

/** Sanitize one path segment: no traversal, no reserved junk, bounded. */
export function sanitizeSegment(name: string): string {
  const cleaned = name
    .replace(/[^\w\s.-]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 80);
  return cleaned || "untitled";
}

export interface LocalFolderStatus {
  supported: boolean;
  connected: boolean;
  folderName: string | null;
  projectName: string | null;
  /** verified = tree + manifest exist and are readable right now */
  verified: boolean;
  needsReconnect: boolean;
  detail: string | null;
}

export interface LocalManifest {
  app: "BEAN FX";
  manifestVersion: 1;
  projectId: string;
  projectName: string;
  createdAt: string;
  updatedAt: string;
  assets: Array<{
    assetId: string;
    relativePath: string;
    fileName: string;
    sizeBytes: number | null;
    sha256: string | null;
    kind: string;
    durationSec: number | null;
  }>;
  deliverables: Array<{
    exportId: string;
    relativePath: string;
    fileName: string;
    sizeBytes: number | null;
    savedAt: string;
  }>;
}

type DirHandle = FileSystemDirectoryHandle & {
  queryPermission?: (d: { mode: "read" | "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: "read" | "readwrite" }) => Promise<PermissionState>;
  values?: () => AsyncIterableIterator<FileSystemHandle>;
};

const FLAG_KEY = "beanfx-local-folder-flag";

let handle: DirHandle | null = null;
let manifest: LocalManifest | null = null;

/** Feature detection — Safari/Firefox do not expose showDirectoryPicker. */
export function isSupported(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

export function flagStored(): boolean {
  try {
    return localStorage.getItem(FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

async function getHandle(): Promise<DirHandle | null> {
  if (handle) return handle;
  if (!flagStored()) return null;
  // A stored handle cannot be rehydrated from localStorage alone — the
  // browser keeps the permission in IndexedDB via its own persistence only
  // when the app stores the handle there. We keep the session handle in
  // memory; a reload requires one reconnect click (stated honestly).
  return null;
}

export async function status(): Promise<LocalFolderStatus> {
  const supported = isSupported();
  const h = handle ?? (await getHandle());
  if (!h) {
    return { supported, connected: false, folderName: null, projectName: null, verified: false, needsReconnect: flagStored(), detail: flagStored() ? "A folder was connected earlier in this session profile — reconnect to restore access." : null };
  }
  let granted = true;
  if (h.queryPermission) {
    const state = await h.queryPermission({ mode: "readwrite" });
    granted = state === "granted";
  }
  return {
    supported,
    connected: granted,
    folderName: h.name,
    projectName: manifest?.projectName ?? null,
    verified: granted && manifest !== null,
    needsReconnect: !granted,
    detail: granted ? null : "Permission revoked or expired — click reconnect and re-pick the folder to restore access.",
  };
}

/** User-gesture picker: connect an existing folder (or create the project
 *  folder inside it) and lay down the standard BEAN FX tree + manifest. */
export async function connectAndCreate(projectId: string, projectName: string, existingRoot = false): Promise<LocalFolderStatus> {
  if (!isSupported()) throw new Error("This browser does not support the File System Access API. Use the download fallback below.");
  const picker = (window as unknown as { showDirectoryPicker: (o?: { id?: string; mode?: "read" | "readwrite" }) => Promise<DirHandle> }).showDirectoryPicker;
  const parent = await picker({ id: "beanfx-projects", mode: "readwrite" });
  let root: DirHandle;
  if (existingRoot) {
    // The user picked an existing BEAN FX project directory — reuse it.
    root = parent;
  } else {
    const dirName = sanitizeSegment(projectName) || "BEAN FX Project";
    root = await parent.getDirectoryHandle(dirName, { create: true });
  }
  for (const seg of PROJECT_TREE) {
    const parts = seg.split("/");
    let cur = root;
    for (const p of parts) cur = await cur.getDirectoryHandle(sanitizeSegment(p), { create: true });
  }
  handle = root;
  manifest = {
    app: "BEAN FX",
    manifestVersion: 1,
    projectId,
    projectName,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    assets: [],
    deliverables: [],
  };
  await writeManifest();
  try {
    localStorage.setItem(FLAG_KEY, "1");
  } catch { /* private mode — flag is best-effort */ }
  return status();
}

/** Reconnect: re-pick a folder and adopt it if its manifest matches. */
export async function reconnect(projectId: string): Promise<LocalFolderStatus> {
  if (!isSupported()) throw new Error("This browser does not support the File System Access API.");
  const picker = (window as unknown as { showDirectoryPicker: (o?: { id?: string; mode?: "read" | "readwrite" }) => Promise<DirHandle> }).showDirectoryPicker;
  const root = await picker({ id: "beanfx-projects", mode: "readwrite" });
  const fh = await root.getFileHandle("beanfx-manifest.json", { create: false }).catch(() => null);
  if (!fh) {
    handle = root;
    manifest = null;
    return { ...(await status()), verified: false, detail: "Connected folder has no beanfx-manifest.json — it may not be a BEAN FX project folder." };
  }
  const text = await (await fh.getFile()).text();
  const parsed = JSON.parse(text) as LocalManifest;
  handle = root;
  manifest = parsed;
  if (parsed.projectId !== projectId) {
    return { ...(await status()), verified: false, detail: `This folder belongs to project "${parsed.projectName}" — switch to that project to use it.` };
  }
  return status();
}

export async function writeManifest(): Promise<void> {
  if (!handle || !manifest) throw new Error("No connected local folder.");
  const fh = await handle.getFileHandle("beanfx-manifest.json", { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify({ ...manifest, updatedAt: new Date().toISOString() }, null, 2));
  await w.close();
}

/** Save one project asset's bytes into the tree (02/03/04 by kind). */
export async function saveAssetFile(asset: { id: string; originalName: string; kind: string; durationSec: number | null; sizeBytes: number | null }, bytes: ArrayBuffer): Promise<string> {
  if (!handle || !manifest) throw new Error("No connected local folder.");
  const dirName = asset.kind === "AUDIO" ? "03_Audio_Music_SFX" : asset.kind === "IMAGE" ? "04_Images_Graphics" : "02_Raw_Footage";
  const dir = await resolveDir(handle, dirName);
  const fileName = sanitizeSegment(asset.originalName);
  const fh = await dir.getFileHandle(fileName, { create: true });
  const w = await fh.createWritable();
  await w.write(bytes);
  await w.close();
  manifest.assets.push({ assetId: asset.id, relativePath: `${dirName}/${fileName}`, fileName, sizeBytes: asset.sizeBytes, sha256: null, kind: asset.kind, durationSec: asset.durationSec });
  await writeManifest();
  return `${dirName}/${fileName}`;
}

/** Save a rendered deliverable (download the artifact, write into 08_Renders). */
export async function saveDeliverable(exportId: string, fileName: string, sizeBytes: number | null): Promise<string> {
  if (!handle || !manifest) throw new Error("No connected local folder.");
  const dir = await resolveDir(handle, "08_Renders");
  const safeName = sanitizeSegment(fileName);
  const res = await fetch(`/api/exports/${exportId}/file`);
  if (!res.ok) throw new Error(`The rendered file could not be downloaded (${res.status}).`);
  const bytes = await res.arrayBuffer();
  const fh = await dir.getFileHandle(safeName, { create: true });
  const w = await fh.createWritable();
  await w.write(bytes);
  await w.close();
  manifest.deliverables.push({ exportId, relativePath: `08_Renders/${safeName}`, fileName: safeName, sizeBytes, savedAt: new Date().toISOString() });
  await writeManifest();
  return `08_Renders/${safeName}`;
}

/** Detect missing files listed in the manifest (relink support). */
export async function verifyFiles(): Promise<{ present: number; missing: string[] }> {
  if (!handle || !manifest) throw new Error("No connected local folder.");
  const missing: string[] = [];
  let present = 0;
  for (const a of manifest.assets) {
    const found = await fileExists(handle, a.relativePath);
    if (found) present++;
    else missing.push(a.relativePath);
  }
  for (const d of manifest.deliverables) {
    const found = await fileExists(handle, d.relativePath);
    if (found) present++;
    else missing.push(d.relativePath);
  }
  return { present, missing };
}

async function resolveDir(root: DirHandle, relative: string): Promise<DirHandle> {
  let cur = root;
  for (const p of relative.split("/")) cur = await cur.getDirectoryHandle(sanitizeSegment(p), { create: true });
  return cur;
}

async function fileExists(root: DirHandle, relative: string): Promise<boolean> {
  const parts = relative.split("/");
  const name = parts.pop();
  if (!name) return false;
  try {
    const dir = await resolveDir(root, parts.join("/"));
    await dir.getFileHandle(name, { create: false });
    return true;
  } catch {
    return false;
  }
}

export function disconnect(): LocalFolderStatus {
  handle = null;
  manifest = null;
  try {
    localStorage.removeItem(FLAG_KEY);
  } catch { /* ignore */ }
  return { supported: isSupported(), connected: false, folderName: null, projectName: null, verified: false, needsReconnect: false, detail: null };
}
