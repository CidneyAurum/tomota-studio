import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";

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
  const target = safeBookPath(root, path);
  if (!readableExtensions.has(extname(target).toLowerCase())) throw new Error("不支持的文件类型");
  const bytes = await readFile(target);
  const info = await stat(target);
  const bookRelative = relative(resolve(root, "books"), target).replaceAll("\\", "/").split("/");
  const category = bookRelative[1] || "";
  return { path: target, content: bytes.toString("utf8"), hash: createHash("sha256").update(bytes).digest("hex"), modifiedAt: info.mtime.toISOString(), editable: editableRoots.has(category) };
}

export async function saveProjectFile(root: string, path: string, content: string, expectedHash: string): Promise<{hash: string; modifiedAt: string}> {
  const current = await readProjectFile(root, path);
  if (!current.editable) throw new Error("该文件由工作流维护，只能查看，不能直接覆盖");
  if (current.hash !== expectedHash) throw new Error("文件已被其他流程更新，请刷新后再保存");
  const target = safeBookPath(root, path);
  await writeFile(target, content, "utf8");
  const info = await stat(target);
  return { hash: createHash("sha256").update(content).digest("hex"), modifiedAt: info.mtime.toISOString() };
}

export async function collectReviewFindings(root: string, bookId: string): Promise<Array<Record<string, unknown>>> {
  if (!/^[A-Za-z0-9_-]+$/.test(bookId)) throw new Error("非法作品编号");
  const book = safeBookPath(root, join(root, "books", bookId));
  const files = await walk(book, book);
  const result: Array<Record<string, unknown>> = [];
  for (const file of files.filter((item) => item.category === "workflow" && /review|cold/.test(item.name) && item.name.endsWith(".json"))) {
    try {
      const value = JSON.parse(await readFile(file.path, "utf8")) as Record<string, unknown>;
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
