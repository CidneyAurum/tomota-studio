# Portable edition notice

This is the executable core of the `webnovel-writing` Skill bundled with Tomota
Studio. It contains the main instructions, modular runtime rules, templates, and
review examples used by the workflow engine.

The portable repository does not contain downloaded novels, article corpora,
PDF demonstrations, scraping assets, or generated corpus indexes. This keeps the
deployment small and avoids treating third-party source texts as application
dependencies. A user-owned full Skill can be selected with the
`TOMOTA_WEBNOVEL_SKILL_ROOT` environment variable.
