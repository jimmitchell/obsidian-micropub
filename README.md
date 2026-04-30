# Obsidian Micropub Publisher

Publish the active Obsidian note to a Micropub-enabled site as an `h-entry`. Embedded images (`![[file.png]]` or `![](relative/path.png)`) are uploaded to the Micropub endpoint as `photo[]` and rewritten to absolute URLs before the post is sent.

Built and tested against [clodd-cms](https://github.com/jimmitchell/clodd-cms)'s `micropub.php`, but should work with any Micropub server that accepts JSON h-entry posts and `multipart/form-data` photo uploads on the same endpoint (or that exposes a separate media endpoint via `q=config` — currently the plugin posts photos to the main endpoint).

## Install (dev / sideload)

```sh
cd ~/Github/obsidian-micropub
npm install
npm run build
```

Then copy `main.js`, `manifest.json` (and `styles.css` if added later) into:

```
<your-vault>/.obsidian/plugins/obsidian-micropub/
```

Enable the plugin under **Settings → Community plugins**.

## Configure

Open **Settings → Micropub Publisher**:

- **Endpoint** — full URL of your Micropub endpoint (e.g. `https://example.com/micropub.php`).
- **Bearer token** — token generated in your CMS Settings → Micropub.

## Use

Three commands:

- **Publish or update current note (published)** — creates a new post if no `url:` is in frontmatter; otherwise sends a Micropub `update` against that URL.
- **Publish or update current note as draft** — same routing, but sets `post-status: draft`.
- **Delete published post** — sends a Micropub `delete` against the `url:` in frontmatter, then removes `url:` from the note (so a subsequent publish creates a fresh post).

On update the post's original publish date is preserved — `published:` in frontmatter is honored only for new posts.

The plugin reads frontmatter for metadata and uses the body as `content`:

```yaml
---
title: My post
slug: my-post              # optional → mp-slug
categories: [foo, bar]     # optional → category[]
status: draft              # optional, draft | published
published: 2026-04-28T10:00:00-05:00   # optional, ISO 8601
---

Note body here. ![[diagram.png]] is uploaded and rewritten.
```

### IndieWeb response posts

Add one of these frontmatter keys to publish a reply, like, repost, or bookmark instead of a plain note. Each accepts a single URL or a list of URLs:

```yaml
---
in-reply-to: https://example.com/their-post
# or: like-of, repost-of, bookmark-of
---
```

On the wire these become `properties.in-reply-to` (etc.) on create, and are also included in `replace` on update if still present in frontmatter.

On success, the response `Location` URL is written back to the note as `url:` in frontmatter.

## Media upload cache

To avoid re-uploading the same image on every publish, the plugin caches each successful upload's resulting URL keyed on the vault file's path, size, and modification time. On subsequent publishes, an unchanged attachment is rewritten to its cached URL without hitting the endpoint.

The cache lives in plugin settings and persists across Obsidian restarts. Manage it under **Settings → Micropub Publisher → Media upload cache**:

- The current entry count is shown in the setting description.
- **Clear cache** — drops all cached URLs. Use this if the server-side media is deleted or moved, or if you've changed endpoints.

A file is considered "changed" if its size or mtime differs from the cached values; editing an image in place will trigger a fresh upload.

## Limitations (v0.4)

- IndieAuth flow is not supported — only static bearer tokens.
- Photos are posted to the main endpoint as `photo[]`. If your server exposes a distinct `media-endpoint` via `q=config`, the plugin doesn't yet route to it.
- On update, only `replace` is sent (whole-property overwrite). Per-property `add`/`delete` operations aren't surfaced as separate commands.
