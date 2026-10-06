import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

import { safeBookPath } from "./store.js";

const readableExtensions = new Set([".md", ".txt", ".json", ".yaml", ".yml", ".toml"]);
const editableRoots = new Set(["drafts", "outlines"]);
const hiddenRoots = new Set([".trash"]);

export interface ProjectFile {
  path: string;
  name: string;
  size: number;
  modifiedAt: string;
  editable: boolean;
  category: string;
  categoryLabel: string;
}

const visibleRoots: Record<string, string> = {drafts: "正文", outlines: "章纲", canon: "设定"};

async function walk(directory: string, base: string): Promise<ProjectFile[]> {
  if (!existsSync(directory)) return [];
  const result: ProjectFile[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || hiddenRoots.has(entry.name)) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(full, base));
    else if (entry.isFile() && readableExtensions.has(extname(entry.name).toLowerCase())) {
      const info = await stat(full);
      const rel = relative(base, full).replaceAll("\\", "/");
      const category = rel.split("/")[0] || "root";
      result.push({ path: full, name: entry.name, size: info.size, modifiedAt: info.mtime.toISOString(), editable: editableRoots.has(category), category, categoryLabel: visibleRoots[category] || category });
    }
  }
  return result.sort((a, b) => a.category.localeCompare(b.category) || a.path.localeCompare(b.path));
}

export async function listProjectFiles(root: string, bookId: string): Promise<ProjectFile[]> {
  if (!/^[A-Za-z0-9_-]+$/.test(bookId)) throw new Error("非法作品编号");
  const book = safeBookPath(root, join(root, "books", bookId));
  const all = await walk(book, book);
  return all.filter((item) => Boolean(visibleRoots[item.category]));
}

export async function readProjectFile(root: string, path: string): Promise<{path: string; content: string; hash: string; modifiedAt: string; editable: boolean}> {
  return readCheckedFile(root, path);
}

function readCheckedFile(root: string, path: string): {path: string; content: string; hash: string; modifiedAt: string; editable: boolean} {
  const target = safeBookPath(root, path);
  if (!readableExtensions.has(extname(target).toLowerCase())) throw new Error("不支持的文件类型");
  const canonical = safeBookPath(root, realpathSync(target));
  const descriptor = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    // Validate the opened object as well as its path, before reading any bytes.
    // There is no event-loop yield between validation and descriptor-based IO.
    const info = fstatSync(descriptor);
    const current = lstatSync(safeBookPath(root, target));
    if (!info.isFile() || info.nlink !== 1 || current.dev !== info.dev || current.ino !== info.ino || realpathSync(target) !== canonical) {
      throw new Error("文件路径或链接已变化，请刷新后重试");
    }
    const bytes = readFileSync(descriptor);
    const bookRelative = relative(resolve(root, "books"), canonical).replaceAll("\\", "/").split("/");
    const category = bookRelative[1] || "";
    return { path: canonical, content: bytes.toString("utf8"), hash: createHash("sha256").update(bytes).digest("hex"), modifiedAt: info.mtime.toISOString(), editable: editableRoots.has(category) };
  } finally {
    closeSync(descriptor);
  }
}

const fileSaves = new Map<string, Promise<void>>();

export async function saveProjectFile(root: string, path: string, content: string, expectedHash: string, assertWritable?: () => void): Promise<{hash: string; modifiedAt: string}> {
  const canonical = safeBookPath(root, realpathSync(safeBookPath(root, path)));
  const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  const previous = fileSaves.get(key) || Promise.resolve();
  let release!: () => void;
  const pending = new Promise<void>((resolveSave) => {release = resolveSave;});
  fileSaves.set(key, pending);
  await previous;
  let temporary: string | undefined;
  try {
    assertWritable?.();
    const current = readCheckedFile(root, path);
    if (current.path !== canonical) throw new Error("文件路径已变化，请刷新后重试");
    if (!current.editable) throw new Error("该文件由工作流维护，只能查看，不能直接覆盖");
    if (current.hash !== expectedHash) throw new Error("文件已被其他流程更新，请刷新后再保存");
    temporary = safeBookPath(root, join(dirname(canonical), `.${basename(canonical)}.${randomUUID()}.tmp`));
    writeFileSync(temporary, content, {encoding: "utf8", flag: "wx", mode: statSync(canonical).mode});
    // Recheck just before atomic replacement, including non-editor writers.
    const latest = readCheckedFile(root, path);
    if (latest.path !== canonical || latest.hash !== expectedHash) throw new Error("文件已被其他流程更新，请刷新后再保存");
    safeBookPath(root, temporary);
    renameSync(temporary, canonical);
    temporary = undefined;
    return { hash: createHash("sha256").update(content).digest("hex"), modifiedAt: statSync(canonical).mtime.toISOString() };
  } finally {
    try {
      if (temporary) unlinkSync(safeBookPath(root, temporary));
    } finally {
      release();
      if (fileSaves.get(key) === pending) fileSaves.delete(key);
    }
  }
}

export async function collectReviewFindings(root: string, bookId: string): Promise<Array<Record<string, unknown>>> {
  if (!/^[A-Za-z0-9_-]+$/.test(bookId)) throw new Error("非法作品编号");
  const book = safeBookPath(root, join(root, "books", bookId));
  const files = await walk(book, book);
  const result: Array<Record<string, unknown>> = [];
  for (const file of files.filter((item) => item.category === "workflow" && /review|cold/.test(item.name) && item.name.endsWith(".json"))) {
    try {
      const value = JSON.parse((await readProjectFile(root, file.path)).content) as Record<string, unknown>;
      for (const finding of Array.isArray(value.findings) ? value.findings : []) {
        if (finding && typeof finding === "object") result.push({ ...finding as Record<string, unknown>, source: file.path, gate: value.gate || value.stage || "review" });
      }
    } catch {
      // Corrupt legacy artifacts are surfaced through the file viewer and do
      // not become valid review evidence.
    }
  }
  return result;
}
