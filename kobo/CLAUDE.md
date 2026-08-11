# Kobo Directory

Form templates, build scripts, and registry for KoboToolbox integration.

## Form Building

`build_form.py` converts JSON templates to XLSForm `.xlsx` files:
```bash
python3 kobo/build_form.py projects/demo/forms/diagnosis.json kobo/forms/diagnosis.xlsx
```

JSON template format: `fields` array with type/name/label/required/appearance/relevant. Supports `relevant` column for conditional sections (e.g., showing different question groups per `vignette_id`).

### Multi-Language Forms

Use object-valued `label` fields instead of strings:
```json
{
  "type": "text",
  "name": "diagnosis",
  "label": {
    "English (en)": "What is your assessment?",
    "Français (fr)": "Quelle est votre évaluation ?"
  }
}
```

`build_form.py` auto-detects multi-language labels and outputs `label::Language (code)` columns. Language names must use `"Name (code)"` format matching KoboToolbox conventions. The `settings.default_language` field controls which language is shown first.

**Gotcha**: Chinese smart quotes (`"` / `"`) are visually identical to JSON `"` delimiters. Always use `\u201c` / `\u201d` escape sequences in Chinese text.

## Registry

`registry.json` maps template names to Kobo form UIDs and Enketo URLs. Managed via `tools/manage-kobo.ts`.

## Form Deployment

Use KoboToolbox MCP tools or CLI:
- `mcp__kobotoolbox__deploy_form` -- deploy new form
- `mcp__kobotoolbox__replace_form` -- update existing form (preserves UID + submissions)
- `mcp__kobotoolbox__export_form` -- download .xlsx for editing

## API Gotchas

KoboToolbox has two API surfaces with different behaviors:

| | kf (`kf.kobotoolbox.org`) | kc (`kc.kobotoolbox.org`) |
|---|---|---|
| **Use for** | Form metadata, XForm XML, v2 REST | Submissions (v1 OpenRosa) |
| **Form ID** | XForm title-based (`ai_med_diagnosis`) | Asset UID (e.g. `aFAKEuid00000000000000000`) |
| **Submit** | v2 POST to `/data/` does NOT work | v1 POST to `/api/v1/submissions` works |
| **Update** | -- | Bulk PATCH only (individual PATCH returns 405) |

Backend handles this mismatch by rewriting submission XML (see `packages/api/CLAUDE.md`).
