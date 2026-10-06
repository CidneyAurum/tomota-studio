# Tomota neutral writing logic

This bundled compatibility skill contains only genre-neutral writing logic.
Tomota does not inject installed third-party story-skill prose, examples,
templates, market assumptions, or lint scripts into generation.

The executable runtime kernel lives in `src/tomota/skill_adapter.py` and is
hashed independently. Authorial style enters only through a published author
profile version and the book's compiled writing policy.
