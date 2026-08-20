# Bundled writing skill

Tomota Studio ships with `skills/webnovel-writing` and reads it directly on a
clean installation. No separate Skill installation is required for Studio.

The bundled edition includes the workflow instructions, ten specialist modules,
templates, review rules, and curated positive/negative examples. Large source
novel corpora, downloaded articles, PDFs, scraping tools, and generated corpus
indexes are intentionally excluded from this portable distribution.

To expose the same Skill to Codex, run from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install_codex_skill.ps1
```

If a Skill with the same name already exists, the script stops without changing
it. Use `-Replace` only when replacement is intended; the old directory is moved
to a timestamped backup rather than deleted.

An advanced user can point Tomota at another complete Skill without modifying
the repository by setting `TOMOTA_WEBNOVEL_SKILL_ROOT`.
