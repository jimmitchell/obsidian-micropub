# Obsidian Micropub Publisher — TODO

- [ ] **Frontmatter `summary:` → Micropub `summary` property** — Read `summary:` from frontmatter and send as `properties.summary` (create) / `replace.summary` (update). Requires matching support on the server: clodd-cms's `micropub.php` currently ignores the property — see its TODO for the endpoint-side change.
