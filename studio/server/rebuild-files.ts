import {existsSync, lstatSync, mkdirSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync} from "node:fs";
import {dirname, isAbsolute, join, relative, resolve} from "node:path";

// A synchronous participant in the Studio SQL transaction. The manifest is
// written BEFORE the first rename, so a dead parent can be recovered by the
// Python coordinator using the durable book_transaction_commits decision.
export class RebuildFiles {
  readonly directory: string;
  private readonly moves: Array<{source: string; staged: string}>;

  constructor(private readonly root: string, bookId: string, token: string, paths: string[]) {
    if (!/^[a-f0-9]{32}$/.test(token)) throw new Error("Invalid rebuild transaction id");
    this.directory = join(root, ".tomota-studio", "rebuild-staging", token);
    this.checked(this.directory);
    // Legacy rows can reference absent placeholder paths. There is nothing to
    // stage for them; every existing target still passes the containment guard.
    const sources = [...new Set(paths.filter(path => existsSync(path)).map(path => this.checked(path)))];
    const selected = sources.filter(path => !sources.some(parent => path !== parent && path.startsWith(parent + (process.platform === "win32" ? "\\" : "/"))));
    this.moves = selected.filter(path => existsSync(path)).map((source, index) => ({
      source: relative(root, source), staged: `files/${index}`,
    }));
    mkdirSync(dirname(this.directory), {recursive: true});
    mkdirSync(this.directory); // Never reuse an earlier transaction's files.
    mkdirSync(join(this.directory, "files"));
    writeFileSync(join(this.directory, "manifest.json"), JSON.stringify({version: 1, token, book_id: bookId, moves: this.moves}), {flag: "wx"});
  }

  private checked(path: string): string {
    const target = resolve(path), rel = relative(this.root, target);
    if (!rel || rel === ".." || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Rebuild file path escaped workspace");
    // No traversal through links/junctions, including a linked staging root.
    let current = this.root;
    for (const part of rel.split(/[\\/]/)) {
      current = join(current, part);
      try {
        if (lstatSync(current).isSymbolicLink()) throw new Error("Rebuild file path contains a link");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return target;
  }

  stage(): void {
    for (const move of this.moves) renameSync(this.checked(join(this.root, move.source)), this.checked(join(this.directory, move.staged)));
  }

  rollback(): void {
    for (const move of [...this.moves].reverse()) {
      const staged = this.checked(join(this.directory, move.staged));
      if (!existsSync(staged)) continue;
      const source = this.checked(join(this.root, move.source));
      if (existsSync(source)) throw new Error(`Rebuild recovery refuses to overwrite ${source}; retained at ${this.directory}`);
      mkdirSync(dirname(source), {recursive: true});
      renameSync(staged, source);
    }
    this.discard();
  }

  discard(): void {
    // Keep the manifest until every staged payload is gone. A partial delete
    // must remain recoverable, not leave an opaque directory without a plan.
    rmSync(this.checked(join(this.directory, "files")), {recursive: true, force: true});
    unlinkSync(this.checked(join(this.directory, "manifest.json")));
    rmdirSync(this.checked(this.directory));
    try { rmdirSync(dirname(this.directory)); } catch { /* Another transaction may own a sibling. */ }
  }
}
