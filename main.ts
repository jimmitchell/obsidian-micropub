import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  requestUrl,
  RequestUrlParam,
  parseYaml,
  stringifyYaml,
  normalizePath,
} from "obsidian";

interface MicropubSettings {
  endpoint: string;
  token: string;
}

const DEFAULT_SETTINGS: MicropubSettings = {
  endpoint: "",
  token: "",
};

interface Frontmatter {
  title?: string;
  slug?: string;
  categories?: string[];
  status?: "draft" | "published";
  published?: string;
  url?: string;
  [key: string]: unknown;
}

interface ParsedNote {
  frontmatter: Frontmatter;
  body: string;
  fmRange: { start: number; end: number } | null;
}

const FM_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function parseNote(raw: string): ParsedNote {
  const m = raw.match(FM_REGEX);
  if (!m) {
    return { frontmatter: {}, body: raw, fmRange: null };
  }
  let fm: Frontmatter = {};
  try {
    const parsed = parseYaml(m[1]);
    if (parsed && typeof parsed === "object") fm = parsed as Frontmatter;
  } catch {
    // ignore — treat as no frontmatter
  }
  return {
    frontmatter: fm,
    body: raw.slice(m[0].length),
    fmRange: { start: 0, end: m[0].length },
  };
}

function writeFrontmatter(raw: string, fm: Frontmatter): string {
  const yaml = stringifyYaml(fm).trimEnd();
  const block = `---\n${yaml}\n---\n`;
  const m = raw.match(FM_REGEX);
  if (!m) return block + raw;
  return block + raw.slice(m[0].length);
}

const EMBED_REGEX = /!\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]/g;
const MD_IMAGE_REGEX = /!\[[^\]]*\]\(([^)\s]+)\)/g;

function isLocalPath(p: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/i.test(p) && !p.startsWith("//");
}

function mimeFor(ext: string): string {
  const e = ext.toLowerCase();
  if (e === "jpg" || e === "jpeg") return "image/jpeg";
  if (e === "png") return "image/png";
  if (e === "gif") return "image/gif";
  if (e === "webp") return "image/webp";
  if (e === "svg") return "image/svg+xml";
  if (e === "avif") return "image/avif";
  return "application/octet-stream";
}

export default class MicropubPlugin extends Plugin {
  settings: MicropubSettings = DEFAULT_SETTINGS;

  async onload() {
    await this.loadSettings();

    this.addCommand({
      id: "micropub-publish",
      name: "Publish or update current note (published)",
      callback: () => this.publishActive("published"),
    });

    this.addCommand({
      id: "micropub-save-draft",
      name: "Publish or update current note as draft",
      callback: () => this.publishActive("draft"),
    });

    this.addCommand({
      id: "micropub-delete",
      name: "Delete published post (uses url frontmatter)",
      callback: () => this.deleteActive(),
    });

    this.addSettingTab(new MicropubSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private endpointUrl(): string | null {
    const ep = this.settings.endpoint.trim();
    if (!ep) return null;
    return ep.replace(/\/+$/, "");
  }

  private async publishActive(statusOverride?: "draft" | "published") {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("Micropub: no active note");
      return;
    }
    if (file.extension !== "md") {
      new Notice("Micropub: active file is not Markdown");
      return;
    }
    const endpoint = this.endpointUrl();
    if (!endpoint) {
      new Notice("Micropub: set the endpoint URL in settings");
      return;
    }
    if (!this.settings.token) {
      new Notice("Micropub: set the bearer token in settings");
      return;
    }

    try {
      await this.publishFile(file, endpoint, statusOverride);
    } catch (err) {
      console.error("Micropub publish failed", err);
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Micropub: ${msg}`, 8000);
    }
  }

  private async publishFile(
    file: TFile,
    endpoint: string,
    statusOverride?: "draft" | "published",
  ) {
    const raw = await this.app.vault.read(file);
    const parsed = parseNote(raw);
    const fm = parsed.frontmatter;

    new Notice("Micropub: uploading images…");
    const body = await this.rewriteEmbeds(parsed.body, file, endpoint);

    const isUpdate = typeof fm.url === "string" && fm.url.trim() !== "";

    const status = statusOverride ?? fm.status;
    const cats = Array.isArray(fm.categories)
      ? fm.categories.map((c) => String(c).trim()).filter((c) => c !== "")
      : [];

    let payload: Record<string, unknown>;

    if (isUpdate) {
      const replace: Record<string, unknown[]> = { content: [body] };
      if (typeof fm.title === "string" && fm.title.trim() !== "") {
        replace.name = [fm.title];
      }
      if (typeof fm.slug === "string" && fm.slug.trim() !== "") {
        replace["mp-slug"] = [fm.slug];
      }
      replace.category = cats;
      if (status === "draft" || status === "published") {
        replace["post-status"] = [status];
      }
      payload = { action: "update", url: fm.url, replace };
    } else {
      const properties: Record<string, unknown[]> = { content: [body] };
      if (typeof fm.title === "string" && fm.title.trim() !== "") {
        properties.name = [fm.title];
      }
      if (typeof fm.slug === "string" && fm.slug.trim() !== "") {
        properties["mp-slug"] = [fm.slug];
      }
      if (typeof fm.published === "string" && fm.published.trim() !== "") {
        properties.published = [fm.published];
      }
      if (cats.length > 0) properties.category = cats;
      if (status === "draft") properties["post-status"] = ["draft"];
      payload = { type: ["h-entry"], properties };
    }

    new Notice(isUpdate ? "Micropub: updating…" : "Micropub: publishing…");
    const res = await requestUrl({
      url: endpoint,
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.settings.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
      throw: false,
    });

    if (res.status < 200 || res.status >= 300) {
      const detail = this.formatErrorBody(res.text);
      throw new Error(`HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
    }

    const location =
      this.headerValue(res.headers, "location") ||
      this.headerValue(res.headers, "Location") ||
      "";

    if (!isUpdate && location) {
      fm.url = location;
      const updated = writeFrontmatter(raw, fm);
      if (updated !== raw) {
        await this.app.vault.modify(file, updated);
      }
    }

    if (isUpdate) {
      new Notice(`Updated: ${fm.url}`, 6000);
    } else {
      new Notice(
        location ? `Published: ${location}` : `Published (HTTP ${res.status})`,
        6000,
      );
    }
  }

  private async deleteActive() {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("Micropub: no active note");
      return;
    }
    const endpoint = this.endpointUrl();
    if (!endpoint || !this.settings.token) {
      new Notice("Micropub: set endpoint and token in settings");
      return;
    }
    try {
      const raw = await this.app.vault.read(file);
      const parsed = parseNote(raw);
      const fm = parsed.frontmatter;
      const url = typeof fm.url === "string" ? fm.url.trim() : "";
      if (!url) {
        new Notice("Micropub: no `url:` in frontmatter — nothing to delete");
        return;
      }

      new Notice("Micropub: deleting…");
      const res = await requestUrl({
        url: endpoint,
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.settings.token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ action: "delete", url }),
        throw: false,
      });

      if (res.status < 200 || res.status >= 300) {
        const detail = this.formatErrorBody(res.text);
        throw new Error(`HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
      }

      delete fm.url;
      const updated = writeFrontmatter(raw, fm);
      if (updated !== raw) await this.app.vault.modify(file, updated);

      new Notice(`Deleted ${url}`, 6000);
    } catch (err) {
      console.error("Micropub delete failed", err);
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Micropub: ${msg}`, 8000);
    }
  }

  private headerValue(
    headers: Record<string, string> | undefined,
    name: string,
  ): string {
    if (!headers) return "";
    const direct = headers[name];
    if (direct) return direct;
    const lower = name.toLowerCase();
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === lower) return headers[k];
    }
    return "";
  }

  private formatErrorBody(text: string): string {
    if (!text) return "";
    try {
      const j = JSON.parse(text);
      if (j && typeof j === "object") {
        const parts: string[] = [];
        if (j.error) parts.push(String(j.error));
        if (j.error_description) parts.push(String(j.error_description));
        if (parts.length) return parts.join(": ");
      }
    } catch {
      // fall through
    }
    return text.slice(0, 200);
  }

  /**
   * Fallback file resolver: matches a linktext against any file in the vault.
   * Tries (in order): exact full path; basename with extension; basename
   * without extension. Returns the first match. Case-insensitive.
   */
  private findFileByLinktext(linktext: string): TFile | null {
    const needle = linktext.replace(/^\/+/, "").toLowerCase();
    if (needle === "") return null;
    const files = this.app.vault.getFiles();
    let basenameNoExt: TFile | null = null;
    for (const f of files) {
      if (f.path.toLowerCase() === needle) return f;
      if (f.name.toLowerCase() === needle) return f;
      if (!basenameNoExt && f.basename.toLowerCase() === needle) {
        basenameNoExt = f;
      }
    }
    return basenameNoExt;
  }

  private async rewriteEmbeds(
    body: string,
    sourceFile: TFile,
    endpoint: string,
  ): Promise<string> {
    const cache = new Map<string, string>();
    const skipped: Array<{ linktext: string; reason: string }> = [];

    const uploadByPath = async (linktext: string): Promise<string | null> => {
      if (!isLocalPath(linktext)) return null;
      const cached = cache.get(linktext);
      if (cached !== undefined) return cached;

      const decoded = decodeURI(linktext);
      let target: TFile | null = this.app.metadataCache.getFirstLinkpathDest(
        decoded,
        sourceFile.path,
      );
      if (!target) target = this.findFileByLinktext(decoded);
      if (!target) {
        skipped.push({
          linktext,
          reason: "no matching file in vault (check path/spelling)",
        });
        return null;
      }
      if (!/\.(png|jpe?g|gif|webp|svg|avif)$/i.test(target.extension)) {
        skipped.push({
          linktext,
          reason: `unsupported type .${target.extension}`,
        });
        return null;
      }

      const data = await this.app.vault.readBinary(target);
      const url = await this.uploadMedia(
        endpoint,
        target.name,
        data,
        mimeFor(target.extension),
      );
      cache.set(linktext, url);
      return url;
    };

    // Replace ![[wiki embeds]]
    const embedReplacements: Array<{ match: string; url: string; alt: string }> = [];
    for (const m of body.matchAll(EMBED_REGEX)) {
      const linktext = m[1].trim();
      const url = await uploadByPath(linktext);
      if (url) {
        const alt = linktext.split("/").pop() ?? "";
        embedReplacements.push({ match: m[0], url, alt });
      }
    }
    for (const r of embedReplacements) {
      body = body.split(r.match).join(`![${r.alt}](${r.url})`);
    }

    // Replace ![alt](relative/path.png) where path is local
    body = await this.replaceAsync(body, MD_IMAGE_REGEX, async (full, src) => {
      if (!isLocalPath(src)) return full;
      const url = await uploadByPath(src);
      return url ? full.replace(src, url) : full;
    });

    if (skipped.length > 0) {
      const list = skipped
        .map((s) => `  • ${s.linktext} — ${s.reason}`)
        .join("\n");
      throw new Error(
        `${skipped.length} image embed${skipped.length === 1 ? "" : "s"} could not be uploaded — refusing to publish:\n${list}`,
      );
    }

    return body;
  }

  private async replaceAsync(
    str: string,
    regex: RegExp,
    replacer: (match: string, ...groups: string[]) => Promise<string>,
  ): Promise<string> {
    const matches: RegExpMatchArray[] = [];
    for (const m of str.matchAll(regex)) matches.push(m);
    let out = "";
    let last = 0;
    for (const m of matches) {
      const idx = m.index ?? 0;
      out += str.slice(last, idx);
      out += await replacer(m[0], ...m.slice(1));
      last = idx + m[0].length;
    }
    out += str.slice(last);
    return out;
  }

  private async uploadMedia(
    endpoint: string,
    filename: string,
    data: ArrayBuffer,
    mime: string,
  ): Promise<string> {
    const boundary =
      "----ObsidianMicropub" + Math.random().toString(16).slice(2);
    const body = buildMultipart(boundary, "photo", filename, data, mime);

    const params: RequestUrlParam = {
      url: endpoint,
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.settings.token}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
      throw: false,
    };
    const res = await requestUrl(params);
    if (res.status < 200 || res.status >= 300) {
      const detail = this.formatErrorBody(res.text);
      throw new Error(
        `image upload failed (HTTP ${res.status})${detail ? ` — ${detail}` : ""}`,
      );
    }
    const location =
      this.headerValue(res.headers, "location") ||
      this.headerValue(res.headers, "Location") ||
      "";
    if (location) return location;

    // Fallback: server returned JSON {url: …}
    try {
      const j = JSON.parse(res.text);
      if (j && typeof j.url === "string") return j.url;
    } catch {
      // ignore
    }
    throw new Error("image upload: no Location returned");
  }
}

function buildMultipart(
  boundary: string,
  fieldName: string,
  filename: string,
  data: ArrayBuffer,
  mime: string,
): ArrayBuffer {
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}[]"; filename="${filename.replace(/"/g, "")}"\r\n` +
      `Content-Type: ${mime}\r\n\r\n`,
  );
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const out = new Uint8Array(head.byteLength + data.byteLength + tail.byteLength);
  out.set(head, 0);
  out.set(new Uint8Array(data), head.byteLength);
  out.set(tail, head.byteLength + data.byteLength);
  return out.buffer;
}

class MicropubSettingTab extends PluginSettingTab {
  plugin: MicropubPlugin;

  constructor(app: App, plugin: MicropubPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Micropub endpoint")
      .setDesc(
        "Full URL to your Micropub endpoint, e.g. https://example.com/micropub.php",
      )
      .addText((t) =>
        t
          .setPlaceholder("https://example.com/micropub.php")
          .setValue(this.plugin.settings.endpoint)
          .onChange(async (v) => {
            this.plugin.settings.endpoint = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Bearer token")
      .setDesc("Generated in your CMS Settings → Micropub.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("token")
          .setValue(this.plugin.settings.token)
          .onChange(async (v) => {
            this.plugin.settings.token = v.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Performs a GET q=config request against the endpoint.")
      .addButton((b) =>
        b.setButtonText("Test").onClick(async () => {
          const ep = this.plugin.settings.endpoint.replace(/\/+$/, "");
          if (!ep || !this.plugin.settings.token) {
            new Notice("Set endpoint and token first");
            return;
          }
          try {
            const res = await requestUrl({
              url: `${ep}?q=config`,
              method: "GET",
              headers: {
                Authorization: `Bearer ${this.plugin.settings.token}`,
                Accept: "application/json",
              },
              throw: false,
            });
            if (res.status >= 200 && res.status < 300) {
              new Notice("Micropub: OK");
            } else {
              new Notice(`Micropub test failed: HTTP ${res.status}`, 6000);
            }
          } catch (e) {
            new Notice(`Micropub test error: ${String(e)}`, 6000);
          }
        }),
      );

    const note = containerEl.createEl("p", {
      cls: "setting-item-description",
    });
    note.setText(
      "Frontmatter keys: title, slug, categories (list), status (draft|published), published (ISO date). " +
        "Embedded images (![[…]] or ![](relative/path)) are uploaded to the media endpoint and rewritten before posting. " +
        "On success, the new post URL is written back to the note as `url:` in frontmatter.",
    );
    void normalizePath; // keep import for future use
  }
}
