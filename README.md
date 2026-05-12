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
- **Pull destination folder** — folder (relative to vault root) where "Pull post from server" creates new notes. Leave blank for vault root.

## Use

Three commands:

- **Publish or update current note** — creates a new post if no `url:` is in frontmatter; otherwise sends a Micropub `update` against that URL. Draft vs published is driven by frontmatter `status:` — set `status: draft` to send `post-status: draft`; anything else (or absent) publishes.
- **Delete published post** — sends a Micropub `delete` against the `url:` in frontmatter, then removes `url:` from the note (so a subsequent publish creates a fresh post).
- **Pull post from server** — fetches the post source via `q=source`. If the active note already has a `url:` in frontmatter, the note is refreshed in place (frontmatter + body overwritten with the server's copy). Otherwise prompts for a URL and creates a new note in the configured destination folder, named after the post's `mp-slug`. Use this to round-trip edits when posts have been changed server-side or by another client.

To flip a draft to published (or vice versa), edit `status:` in frontmatter and re-run the publish command — on updates, `post-status` is sent in `replace`, so the server-side state follows the note.

On update the post's original publish date is preserved — `published:` in frontmatter is honored only for new posts.

The plugin reads frontmatter for metadata and uses the body as `content`:

```yaml
---
title: My post
slug: my-post              # optional → mp-slug
summary: A short excerpt.  # optional → summary (used by feeds & syndication)
categories: [foo, bar]     # optional → category[]
status: draft              # optional, draft | published
published: 2026-04-28T10:00:00-05:00   # optional, ISO 8601
---

Note body here. ![[diagram.png]] is uploaded and rewritten.
```

`summary:` is mirrored exactly on update — removing the key (or leaving it blank) sends a Micropub `delete: ["summary"]` so the server-side excerpt is cleared and the feed falls back to its auto-derived value.

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

## Limitations (v0.6)

- IndieAuth flow is not supported — only static bearer tokens.
- Photos are posted to the main endpoint as `photo[]`. If your server exposes a distinct `media-endpoint` via `q=config`, the plugin doesn't yet route to it.
- Update payloads use `replace` for all surfaced properties (whole-property overwrite); the only `delete` op the plugin emits is clearing `summary` when the frontmatter key is absent. Per-property `add` isn't exposed.
- "Pull post from server" overwrites the active note's body and any server-managed frontmatter keys (title, slug, summary, categories, status, published, url) without confirmation. Frontmatter keys the server doesn't track (e.g. `in-reply-to`) are preserved.
