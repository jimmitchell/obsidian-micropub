import {
  App,
  Modal,
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

interface MediaCacheEntry {
  size: number;
  mtime: number;
  url: string;
}

interface MicropubSettings {
  endpoint: string;
  token: string;
  pullFolder: string;
  mediaCache: Record<string, MediaCacheEntry>;
}

const DEFAULT_SETTINGS: MicropubSettings = {
  endpoint: "",
  token: "",
  pullFolder: "",
  mediaCache: {},
};

interface Frontmatter {
  title?: string;
  slug?: string;
  summary?: string;
  categories?: string[];
  status?: "draft" | "published";
  published?: string;
  url?: string;
  "in-reply-to"?: string | string[];
  "like-of"?: string | string[];
  "repost-of"?: string | string[];
  "bookmark-of"?: string | string[];
  [key: string]: unknown;
}

function firstString(arr: unknown): string | undefined {
  if (!Array.isArray(arr)) return undefined;
  const v = arr[0];
  return typeof v === "string" ? v : undefined;
}

const RESPONSE_PROPS = [
  "in-reply-to",
  "like-of",
  "repost-of",
  "bookmark-of",
] as const;

function asUrlList(v: unknown): string[] {
  if (typeof v === "string") {
    const s = v.trim();
    return s === "" ? [] : [s];
  }
  if (Array.isArray(v)) {
    return v
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.trim())
      .filter((x) => x !== "");
  }
  return [];
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
      name: "Publish or update current note",
      callback: () => this.publishActive(),
    });

    this.addCommand({
      id: "micropub-delete",
      name: "Delete published post (uses url frontmatter)",
      callback: () => this.deleteActive(),
    });

    this.addCommand({
      id: "micropub-pull",
      name: "Pull post from server (refresh active note or pull by URL)",
      callback: () => this.pullActive(),
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

  private async publishActive() {
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
      await this.publishFile(file, endpoint);
    } catch (err) {
      console.error("Micropub publish failed", err);
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Micropub: ${msg}`, 8000);
    }
  }

  private async publishFile(file: TFile, endpoint: string) {
    const raw = await this.app.vault.read(file);
    const parsed = parseNote(raw);
    const fm = parsed.frontmatter;

    new Notice("Micropub: uploading images…");
    const body = await this.rewriteEmbeds(parsed.body, file, endpoint);

    const isUpdate = typeof fm.url === "string" && fm.url.trim() !== "";

    const status: "draft" | "published" =
      fm.status === "draft" ? "draft" : "published";
    const cats = Array.isArray(fm.categories)
      ? fm.categories.map((c) => String(c).trim()).filter((c) => c !== "")
      : [];

    const summary =
      typeof fm.summary === "string" ? fm.summary.trim() : "";

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
      replace["post-status"] = [status];
      for (const prop of RESPONSE_PROPS) {
        const urls = asUrlList(fm[prop]);
        if (urls.length > 0) replace[prop] = urls;
      }
      const deletes: string[] = [];
      if (summary !== "") {
        replace.summary = [summary];
      } else {
        deletes.push("summary");
      }
      payload = { action: "update", url: fm.url, replace };
      if (deletes.length > 0) payload.delete = deletes;
    } else {
      const properties: Record<string, unknown[]> = { content: [body] };
      if (typeof fm.title === "string" && fm.title.trim() !== "") {
        properties.name = [fm.title];
      }
      if (typeof fm.slug === "string" && fm.slug.trim() !== "") {
        properties["mp-slug"] = [fm.slug];
      }
      if (summary !== "") properties.summary = [summary];
      if (typeof fm.published === "string" && fm.published.trim() !== "") {
        properties.published = [fm.published];
      }
      if (cats.length > 0) properties.category = cats;
      if (status === "draft") properties["post-status"] = ["draft"];
      for (const prop of RESPONSE_PROPS) {
        const urls = asUrlList(fm[prop]);
        if (urls.length > 0) properties[prop] = urls;
      }
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

    if (location && location !== fm.url) {
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

  private async pullActive() {
    const endpoint = this.endpointUrl();
    if (!endpoint || !this.settings.token) {
      new Notice("Micropub: set endpoint and token in settings");
      return;
    }

    const active = this.app.workspace.getActiveFile();
    let target: { file: TFile; raw: string; fm: Frontmatter } | null = null;
    let url = "";

    if (active && active.extension === "md") {
      const raw = await this.app.vault.read(active);
      const parsed = parseNote(raw);
      const fmUrl =
        typeof parsed.frontmatter.url === "string"
          ? parsed.frontmatter.url.trim()
          : "";
      if (fmUrl !== "") {
        target = { file: active, raw, fm: parsed.frontmatter };
        url = fmUrl;
      }
    }

    if (url === "") {
      const entered = await new UrlPromptModal(
        this.app,
        "Pull post from URL",
        "Paste the post URL to fetch its source from the server.",
      ).openAndWait();
      if (!entered) return;
      url = entered;
    }

    try {
      const props = await this.fetchSource(endpoint, url);
      await this.applyPulledSource(props, url, target);
    } catch (err) {
      console.error("Micropub pull failed", err);
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Micropub: ${msg}`, 8000);
    }
  }

  private async fetchSource(
    endpoint: string,
    url: string,
  ): Promise<Record<string, unknown[]>> {
    const qs = new URLSearchParams({ q: "source", url });
    const res = await requestUrl({
      url: `${endpoint}?${qs.toString()}`,
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.settings.token}`,
        Accept: "application/json",
      },
      throw: false,
    });
    if (res.status < 200 || res.status >= 300) {
      const detail = this.formatErrorBody(res.text);
      throw new Error(`HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(res.text);
    } catch {
      throw new Error("source response was not JSON");
    }
    if (!json || typeof json !== "object") {
      throw new Error("source response missing properties");
    }
    const props = (json as { properties?: unknown }).properties;
    if (!props || typeof props !== "object") {
      throw new Error("source response missing properties");
    }
    return props as Record<string, unknown[]>;
  }

  private async applyPulledSource(
    props: Record<string, unknown[]>,
    fallbackUrl: string,
    target: { file: TFile; raw: string; fm: Frontmatter } | null,
  ) {
    const newFm: Frontmatter = target ? { ...target.fm } : {};

    const name = firstString(props.name);
    if (name !== undefined) newFm.title = name;
    else delete newFm.title;

    const slug = firstString(props["mp-slug"]);
    if (slug !== undefined) newFm.slug = slug;
    else delete newFm.slug;

    const summary = firstString(props.summary);
    if (summary !== undefined && summary !== "") newFm.summary = summary;
    else delete newFm.summary;

    const status = firstString(props["post-status"]);
    if (status === "draft" || status === "published") newFm.status = status;
    else delete newFm.status;

    const published = firstString(props.published);
    if (published !== undefined) newFm.published = published;
    else delete newFm.published;

    if (Array.isArray(props.category)) {
      const cats = props.category
        .filter((c): c is string => typeof c === "string")
        .map((c) => c.trim())
        .filter((c) => c !== "");
      if (cats.length > 0) newFm.categories = cats;
      else delete newFm.categories;
    } else {
      delete newFm.categories;
    }

    const serverUrl = firstString(props.url);
    newFm.url = serverUrl && serverUrl !== "" ? serverUrl : fallbackUrl;

    const body = firstString(props.content) ?? "";
    const yaml = stringifyYaml(newFm).trimEnd();
    const content = `---\n${yaml}\n---\n${body}`;

    if (target) {
      await this.app.vault.modify(target.file, content);
      new Notice(`Pulled: ${newFm.url}`, 6000);
      return;
    }

    const slugForName = (newFm.slug ?? "untitled").replace(/[\\/:]/g, "-");
    const folder = this.settings.pullFolder.trim().replace(/^\/+|\/+$/g, "");
    const path = normalizePath(
      folder ? `${folder}/${slugForName}.md` : `${slugForName}.md`,
    );
    if (this.app.vault.getAbstractFileByPath(path)) {
      throw new Error(`${path} already exists`);
    }
    const created = await this.app.vault.create(path, content);
    await this.app.workspace.getLeaf().openFile(created);
    new Notice(`Pulled to ${path}`, 6000);
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
    const uploadedUrls = new Set<string>();
    const skipped: Array<{ linktext: string; reason: string }> = [];

    const uploadByPath = async (linktext: string): Promise<string | null> => {
      if (!isLocalPath(linktext)) return null;
      if (uploadedUrls.has(linktext)) return null;
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
      if (!/^(png|jpe?g|gif|webp|svg|avif)$/i.test(target.extension)) {
        skipped.push({
          linktext,
          reason: `unsupported type .${target.extension}`,
        });
        return null;
      }

      const cacheKey  = target.path;
      const stat      = target.stat;
      const cachedHit = this.settings.mediaCache[cacheKey];
      if (
        cachedHit &&
        cachedHit.size === stat.size &&
        cachedHit.mtime === stat.mtime
      ) {
        cache.set(linktext, cachedHit.url);
        uploadedUrls.add(cachedHit.url);
        return cachedHit.url;
      }

      const data = await this.app.vault.readBinary(target);
      const url = await this.uploadMedia(
        endpoint,
        target.name,
        data,
        mimeFor(target.extension),
      );
      cache.set(linktext, url);
      uploadedUrls.add(url);
      this.settings.mediaCache[cacheKey] = {
        size: stat.size,
        mtime: stat.mtime,
        url,
      };
      await this.saveSettings();
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
    const body = buildMultipart(boundary, "file", filename, data, mime);

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

class UrlPromptModal extends Modal {
  private resolver: ((value: string | null) => void) | null = null;
  private settled = false;
  private input!: HTMLInputElement;

  constructor(
    app: App,
    private heading: string,
    private description: string,
  ) {
    super(app);
  }

  openAndWait(): Promise<string | null> {
    return new Promise((resolve) => {
      this.resolver = resolve;
      this.open();
    });
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText(this.heading);
    contentEl.createEl("p", {
      text: this.description,
      cls: "setting-item-description",
    });

    this.input = contentEl.createEl("input", { type: "text" });
    this.input.placeholder = "https://example.com/2026/05/11/my-slug/";
    this.input.style.width = "100%";
    this.input.style.marginBottom = "1em";

    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    const okBtn = buttons.createEl("button", {
      text: "Pull",
      cls: "mod-cta",
    });
    const cancelBtn = buttons.createEl("button", { text: "Cancel" });

    const submit = () => {
      const v = this.input.value.trim();
      if (v === "") return;
      this.settle(v);
      this.close();
    };
    okBtn.addEventListener("click", submit);
    cancelBtn.addEventListener("click", () => {
      this.settle(null);
      this.close();
    });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });

    setTimeout(() => this.input.focus(), 0);
  }

  onClose() {
    this.contentEl.empty();
    this.settle(null);
  }

  private settle(value: string | null) {
    if (this.settled) return;
    this.settled = true;
    this.resolver?.(value);
    this.resolver = null;
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
      `Content-Disposition: form-data; name="${fieldName}"; filename="${filename.replace(/"/g, "")}"\r\n` +
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
      .setName("Pull destination folder")
      .setDesc(
        "Folder (relative to the vault root) where \"Pull post from server\" " +
          "creates new notes when there's no active note linked by `url:`. " +
          "Leave blank to create at the vault root. The note filename is the post's `mp-slug`.",
      )
      .addText((t) =>
        t
          .setPlaceholder("e.g. Posts or Inbox/From server")
          .setValue(this.plugin.settings.pullFolder)
          .onChange(async (v) => {
            this.plugin.settings.pullFolder = v.trim();
            await this.plugin.saveSettings();
          }),
      );

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

    const cacheCount = Object.keys(this.plugin.settings.mediaCache).length;
    new Setting(containerEl)
      .setName("Media upload cache")
      .setDesc(
        `${cacheCount} entr${cacheCount === 1 ? "y" : "ies"} cached. ` +
          "Vault files that haven't changed (same size and mtime) reuse their previously uploaded URL instead of re-uploading.",
      )
      .addButton((b) =>
        b.setButtonText("Clear cache").onClick(async () => {
          this.plugin.settings.mediaCache = {};
          await this.plugin.saveSettings();
          new Notice("Micropub: media cache cleared");
          this.display();
        }),
      );

    const note = containerEl.createEl("p", {
      cls: "setting-item-description",
    });
    note.setText(
      "Frontmatter keys: title, slug, summary, categories (list), status (draft|published), published (ISO date), " +
        "in-reply-to / like-of / repost-of / bookmark-of (URL or list of URLs for IndieWeb response posts). " +
        "Embedded images (![[…]] or ![](relative/path)) are uploaded to the media endpoint and rewritten before posting. " +
        "On success, the post URL is written back to the note as `url:` in frontmatter. " +
        "Use \"Pull post from server\" to refresh that note from the server (or pull a new post by URL).",
    );
  }
}
