// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.

// Client side of the server-side model store.
//
// The playground runs on BrowserFS: a read-only layer of bundled libraries
// over a writable in-memory / localStorage layer. There is no HTTP-backed
// filesystem, so instead of replacing BrowserFS we *mirror* a server folder
// into the writable layer. Because the file picker enumerates the filesystem,
// anything mirrored here shows up in the file dropdown automatically, and
// pushes write edits back to the server.

import { join } from './filesystem.ts';

/** Directory (inside the in-browser FS) where server files are mirrored. */
export const serverDir = '/server';

/**
 * Base path of the files API, or '' when the server file store is disabled.
 *
 * Enabled at build time via the SERVER_FILES_API env var (the Docker image
 * sets it to '/api'), or at runtime by setting `window.__OPENSCAD_FILES_API__`
 * before the bundle loads. When empty the client makes no requests at all, so
 * a plain static deployment stays error-free.
 */
export const filesApiBase: string =
  (typeof window !== 'undefined' && (window as any).__OPENSCAD_FILES_API__) ||
  process.env.SERVER_FILES_API ||
  '';

export type ServerFile = { name: string; size: number; mtime: number };

const isScad = (name: string) => name.toLowerCase().endsWith('.scad');

/** Create `path` and any missing parents (BrowserFS has no mkdir -p). */
function ensureDir(fs: FS, path: string): void {
  const parts = path.split('/').filter(Boolean);
  let cur = '';
  for (const part of parts) {
    cur += `/${part}`;
    try {
      if (!fs.existsSync(cur)) fs.mkdirSync(cur);
    } catch (e) {
      // EEXIST / already mounted: nothing to do.
    }
  }
}

function readText(fs: FS, path: string): string | null {
  try {
    return new TextDecoder('utf-8').decode(fs.readFileSync(path));
  } catch (e) {
    return null;
  }
}

export class ServerFileSync {
  /** Last server mtime we mirrored per local path, to avoid needless refetch. */
  private mtimes = new Map<string, number>();
  private listeners = new Set<() => void>();
  private timer: any = null;
  public lastError: string | null = null;

  constructor(
    private fs: FS,
    /** How often to poll for files added/changed by other clients. */
    private intervalMs = 5000,
  ) {}

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (e) {
        console.error('server-sync listener failed:', e);
      }
    }
  }

  private url(name?: string): string {
    return name == null
      ? `${filesApiBase}/files`
      : `${filesApiBase}/files/${encodeURIComponent(name)}`;
  }

  async manifest(): Promise<ServerFile[]> {
    const res = await fetch(this.url(), { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`GET ${this.url()} -> ${res.status}`);
    return (await res.json()) as ServerFile[];
  }

  /**
   * Mirror the server folder into the in-browser FS.
   *
   * @param activePath file the user is editing; it is never removed, and is
   *                   not overwritten once we already have a copy (so remote
   *                   changes don't yank the buffer out from under the user).
   * @returns true if anything in the FS changed.
   */
  async pull(activePath?: string): Promise<boolean> {
    const files = await this.manifest();
    ensureDir(this.fs, serverDir);

    let changed = false;
    const present = new Set(
      this.fs.readdirSync(serverDir).filter((n) => isScad(n)),
    );

    for (const f of files) {
      if (!isScad(f.name)) continue;
      const local = join(serverDir, f.name);
      present.delete(f.name);

      const known = this.mtimes.get(local);
      const need = known == null || f.mtime > known;
      if (!need) continue;
      // Don't clobber a file we are already editing.
      if (activePath === local && known != null) continue;

      const res = await fetch(this.url(f.name));
      if (!res.ok) continue;
      const text = await res.text();
      try {
        this.fs.writeFileSync(local, text);
      } catch (e) {
        console.error(`Failed to mirror ${f.name}:`, e);
        continue;
      }
      this.mtimes.set(local, f.mtime);
      changed = true;
    }

    // Drop files that disappeared on the server (unless being edited).
    for (const name of present) {
      const local = join(serverDir, name);
      if (activePath === local) continue;
      try {
        this.fs.unlinkSync(local);
        this.mtimes.delete(local);
        changed = true;
      } catch (e) {
        /* ignore */
      }
    }

    if (changed) this.emit();
    return changed;
  }

  /** Create or update a file on the server (and mirror it locally). */
  async push(name: string, content: string): Promise<ServerFile> {
    const res = await fetch(this.url(name), {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: content,
    });
    if (!res.ok) throw new Error(`PUT ${this.url(name)} -> ${res.status}`);
    const meta = (await res.json()) as ServerFile;
    const local = join(serverDir, name);
    ensureDir(this.fs, serverDir);
    try {
      this.fs.writeFileSync(local, content);
    } catch (e) {
      console.error(`Failed to mirror saved file ${name}:`, e);
    }
    this.mtimes.set(local, meta.mtime);
    return meta;
  }

  async remove(name: string): Promise<void> {
    const res = await fetch(this.url(name), { method: 'DELETE' });
    if (!res.ok && res.status !== 404) {
      throw new Error(`DELETE ${this.url(name)} -> ${res.status}`);
    }
    const local = join(serverDir, name);
    try {
      this.fs.unlinkSync(local);
    } catch (e) {
      /* ignore */
    }
    this.mtimes.delete(local);
    this.emit();
  }

  /** Begin polling for remote changes. `getActivePath` guards the open file. */
  startPolling(getActivePath?: () => string | undefined): void {
    if (this.timer != null) return;
    this.timer = setInterval(() => {
      this.pull(getActivePath?.()).catch((e) => {
        this.lastError = `${e}`;
      });
    }, this.intervalMs);
  }

  stopPolling(): void {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Read the mirrored copy of a server file (null if not mirrored). */
  readLocal(name: string): string | null {
    return readText(this.fs, join(serverDir, name));
  }
}
