# Bundled neutral writing logic

Tomota ships a small, sealed logic core under `skills/webnovel-writing` for
backward-compatible discovery. Despite the legacy directory name, it contains
no platform, market, genre, audience, plot, pacing, or prose preset.

Installed third-party story skills may be inventoried for diagnostics, but
their prose, examples, templates, corpora, and lint scripts are not generation
inputs. A change in those packages cannot alter or stop a Tomota workflow.

Authorial style enters only through a user-published author profile version and
the book's `CompiledWritingPolicy`. The neutral core is lower priority than the
user, Canon, book/volume/chapter contracts, book overrides, and author policy.
