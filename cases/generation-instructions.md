# Variant Generation Instructions

These instructions apply when generating a demographically adapted variant from a base case template.

## Inputs

- **Base case**: `cases/<template>/base.md` — the canonical complete case
- **Template metadata**: `cases/<template>/meta.json` — clinical invariants that must not change
- **Profile**: `projects/<project>/cases/<template>/profiles.json` — project-specific demographic profiles
- **Project config**: `projects/<project>/project.json` — includes language list for name derivation

## Name Derivation

Profiles do NOT include patient or family names. You MUST derive culturally appropriate names based on:
- The profile's **gender**
- The project's **language list** (e.g., English names for `["en"]`, Thai names for `["th"]`)

Rules:
- Never reuse names from `base.md` or any existing variant in the same project
- Check `projects/<project>/cases/<template>/variants.json` for names already in use
- Family contact names must also be freshly derived

## What to Preserve

- **The H1 case title** — must match `base.md` exactly. Do not append setting or demographic info to the title.
- All clinical invariants listed in `meta.json` `clinicalInvariants` array — exactly as specified
- All provider questions — verbatim, do not change question wording
- The markdown structure and section ordering from `base.md`

## What to Adapt

Based on the profile, adapt:
- Patient name, family contact name (derived, not from profile)
- Age, gender (pronouns, exam wording, physical description)
- Occupation, living situation, marital status
- Setting description, referral source
- Lifestyle details, social history
- SP response voice, personality, and setting-specific details
- Emotional cues, volunteered statements
- Counseling points and learning objectives (to reflect the setting)

SP responses to provider questions must convey the same clinical substance but may be adapted for voice, setting, and personality.

Vitals should stay within the same clinical range but do not need to be identical numbers.

## Quality Checks

After generating a variant, verify:
- The H1 title matches `base.md` exactly
- No names from `base.md` or other variants appear anywhere in the output
- All provider questions are present and verbatim
- All clinical invariants from `meta.json` are preserved (scores, conditions, medications, doses)
- Chief complaint mechanism matches the invariant
- File follows the exact same markdown structure and section ordering as `base.md`

## Rubric Setup

When setting up a new project (or adding a new case template to an existing project), copy the evaluation rubrics from the base case template to the project's case directory:

```
cp cases/<template>/*_rubric.json projects/<project>/cases/<template>/
cp cases/<template>/*_checklist.json projects/<project>/cases/<template>/
```

Each rubric/checklist file has a `"source"` field declaring what data it grades:
- `"transcript"` -- grades the chat conversation transcript
- `"field:<name>"` -- grades a specific Kobo form field (e.g., `"field:diagnosis"`)
- Items can override the file-level source with `"data_source"` (e.g., `"survey_time"` for time-based scoring)

The project copies can be freely edited:
- Add, remove, or modify rubric items to match project-specific evaluation needs
- Add entirely new rubric files (any `*_rubric.json` or `*_checklist.json` file will be auto-discovered by the grading pipeline)
- Change the `"source"` field if targeting a different Kobo form field

## Kobo Form Setup

Each project needs its own Kobo form for collecting student diagnoses. The form is defined as a JSON template, built into XLSForm format, and deployed to KoboToolbox.

1. Copy the base form template to the project:
```
cp kobo/templates/diagnosis.json projects/<project>/forms/diagnosis.json
```

2. Edit the project copy to add project-specific fields, conditional sections, or modified labels. The `case_template` hidden field enables XLSForm `relevant` expressions for showing/hiding sections by case type.

3. Build the XLSForm:
```
python kobo/build_form.py projects/<project>/forms/diagnosis.json
```

4. Deploy to KoboToolbox (via MCP tools or manual upload), then record the form UID in `project.json`:
```json
"kobo": {
  "template": "projects/<project>/forms/diagnosis.json",
  "formUid": "<uid-from-kobo>",
  "formUrl": "https://ee.kobotoolbox.org/single/<enketo-id>"
}
```

5. Update `kobo/registry.json` with the deployment info so the registry stays current across projects.

## Registration

After writing the variant file, register it:

```
npx tsx tools/generate-case.ts register <template> <profile-id> <project> <file-path> [--title "..."]
```

This handles UUID assignment, validation, `variants.json` update, and `project.json` update.
