"""
AI-MED Unified Grader

Dynamically discovers rubric/checklist files and grades submissions
against the appropriate data source for each rubric.

Uses Claude Opus with extended thinking for deep, accurate grading.

Requirements:
    - Claude CLI installed: npm install -g @anthropic-ai/claude-code
    - CLAUDE_CODE_OAUTH_TOKEN environment variable (from Max subscription or API key)

Usage:
    python grade.py --project demo
"""

import os
import json
import argparse
import pandas as pd
import subprocess
from pathlib import Path
from datetime import datetime

# Configuration
PROJECT_ROOT = Path(__file__).parent.parent.parent  # ai-med/


# ── Project & rubric loading ────────────────────────────────────────


def load_project_config(project_name):
    """Load project.json for the given project."""
    config_path = PROJECT_ROOT / "projects" / project_name / "project.json"
    with open(config_path) as f:
        return json.load(f)


def discover_rubrics(project_name, template):
    """Discover all rubric/checklist JSON files in the project case directory."""
    rubric_dir = PROJECT_ROOT / "projects" / project_name / "cases" / template
    files = sorted(rubric_dir.glob("*_rubric.json")) + sorted(rubric_dir.glob("*_checklist.json"))

    rubrics = {}
    for f in files:
        key = f.stem  # e.g., "scoring_rubric", "question_checklist"
        with open(f) as fh:
            rubrics[key] = json.load(fh)
        print(f"  Loaded rubric: {key} (source: {rubrics[key].get('source', 'transcript')})")

    return rubrics


def load_profiles(project_name, template):
    """Load profile data for vignette-to-profile mapping."""
    profiles_path = PROJECT_ROOT / "projects" / project_name / "cases" / template / "profiles.json"
    try:
        with open(profiles_path) as f:
            profiles_list = json.load(f)
        return {p["id"]: {k: v for k, v in p.items() if k != "id"} for p in profiles_list}
    except FileNotFoundError:
        return {}


def build_vignette_map(config):
    """Build mapping from vignette key to profile ID and title."""
    vignettes = config.get("cases", {}).get("vignettes", [])
    return {v["key"]: v for v in vignettes}


# ── Transcript helpers ──────────────────────────────────────────────


def extract_user_messages(transcript):
    """Extract only user messages from the transcript."""
    lines = transcript.split("\n")
    user_messages = []
    current_message = []
    in_user = False

    for line in lines:
        if line.startswith("User:"):
            if current_message and in_user:
                user_messages.append(" ".join(current_message))
            in_user = True
            text = line[5:].strip()
            current_message = [text] if text else []
        elif line.startswith("Patient:") or line.startswith("Assistant:"):
            if current_message and in_user:
                user_messages.append(" ".join(current_message))
            in_user = False
            current_message = []
        elif in_user:
            current_message.append(line.strip())

    if current_message and in_user:
        user_messages.append(" ".join(current_message))

    return user_messages


def calculate_time_score(start_time, end_time, max_points=20, max_valid_duration=60):
    """Calculate time-based score (1 point per minute, max 20)."""
    try:
        start = pd.to_datetime(start_time)
        end = pd.to_datetime(end_time)
        duration_minutes = (end - start).total_seconds() / 60
        if duration_minutes > max_valid_duration or duration_minutes < 0:
            return 0, None
        return min(int(duration_minutes), max_points), round(duration_minutes, 2)
    except Exception:
        return 0, None


def parse_transcript_filename(filename):
    """Parse transcript filename: {uid}_{vignette_id}_{YYYYMMDD}_{HHMMSS}.txt"""
    stem = Path(filename).stem
    parts = stem.split("_")
    uid = parts[0]
    # vignette_id is the hash key (everything between uid and the date)
    # Date is 8 digits, time is 6 digits at the end
    date_part = parts[-2]
    time_part = parts[-1]
    vignette_id = "_".join(parts[1:-2])
    return uid, vignette_id, f"{date_part}_{time_part}"


# ── Grading prompts ─────────────────────────────────────────────────


def build_scoring_rubric_prompt(text, rubric, is_transcript=True):
    """Build prompt for scoring rubric (categories with scored items)."""
    if is_transcript:
        user_messages = extract_user_messages(text)
        text_desc = "STUDENT'S QUESTIONS/STATEMENTS"
        text_content = "\n".join([f"- {msg}" for msg in user_messages if msg.strip()])
    else:
        text_desc = "STUDENT'S WRITTEN RESPONSE"
        text_content = text

    rubric_items = []
    for category in rubric.get("categories", []):
        for item in category["items"]:
            if item.get("data_source") == "survey_time":
                continue  # Handled separately
            rubric_items.append({
                "id": item["id"],
                "category": category["name"],
                "description": item["description"],
                "grading_rubric": item["grading_rubric"],
            })

    return f"""You are grading a medical student's interaction with a simulated elderly patient.

## {text_desc}:
{text_content}

## SCORING RUBRIC ITEMS:
For each item, determine if the student addressed it (score=1) or not (score=0).
Provide a brief quote as evidence if scored=1.

{json.dumps(rubric_items, indent=2)}

## RESPONSE FORMAT:
Return a JSON object:
{{
  "rubric_scores": [
    {{"id": "item_id", "score": 0 or 1, "evidence": "quote or null"}}
  ],
  "overall_notes": "Brief assessment"
}}

Return ONLY valid JSON."""


def build_checklist_prompt(text, checklist, is_transcript=True):
    """Build prompt for question checklist (sections with items to check)."""
    if is_transcript:
        user_messages = extract_user_messages(text)
        text_desc = "STUDENT'S QUESTIONS/STATEMENTS"
        text_content = "\n".join([f"- {msg}" for msg in user_messages if msg.strip()])
    else:
        text_desc = "STUDENT'S WRITTEN RESPONSE"
        text_content = text

    checklist_items = []
    for section in checklist.get("sections", []):
        for item in section["items"]:
            entry = {"id": item["id"], "section": section["name"]}
            if "question" in item:
                entry["question"] = item["question"]
                entry["topic"] = item.get("topic", "")
            elif "criterion" in item:
                entry["criterion"] = item["criterion"]
                entry["look_for"] = item.get("look_for", "")
            checklist_items.append(entry)

    # Use "asked" for question checklists, "present" for assessment checklists
    has_questions = any("question" in item for item in checklist_items)
    field_name = "asked" if has_questions else "present"
    field_desc = "asked about this topic" if has_questions else "present in the text"

    return f"""Analyze this medical student's response.

## {text_desc}:
{text_content}

## CHECKLIST:
For each item, determine if it was {field_desc} (true/false).

{json.dumps(checklist_items, indent=2)}

## RESPONSE FORMAT:
Return a JSON object:
{{
  "items": [
    {{"id": "item_id", "{field_name}": true or false, "evidence": "quote or null"}}
  ]
}}

Return ONLY valid JSON."""


def call_claude(prompt, system_msg="You are an expert medical education evaluator. Return only valid JSON.", max_tokens=8000):
    """
    Call Claude via CLI with extended thinking (Max subscription).
    Uses CLAUDE_CODE_OAUTH_TOKEN from environment.
    """
    full_prompt = f"{system_msg}\n\n{prompt}"
    try:
        result = subprocess.run(
            [
                "claude", "-p",
                "--model", "opus",
                "--thinking", "enabled",  # Enable extended thinking for deeper analysis
                "--output-format", "text",
                "--no-session-persistence",
            ],
            input=full_prompt,
            capture_output=True,
            text=True,
            timeout=600,  # 10 minutes for extended thinking
        )
        if result.returncode == 0 and result.stdout.strip():
            # Parse JSON from output
            output = result.stdout.strip()
            # Handle <think> tags if present - extract JSON after thinking
            if "<think>" in output and "</think>" in output:
                # Extract content after </think> tag
                json_start = output.find("</think>") + len("</think>")
                output = output[json_start:].strip()
            # Find JSON object in output
            json_start = output.find("{")
            json_end = output.rfind("}") + 1
            if json_start >= 0 and json_end > json_start:
                json_str = output[json_start:json_end]
                return json.loads(json_str)
            return None
        else:
            print(f"    Claude CLI failed (rc={result.returncode}): {result.stderr[:200]}")
            return None
    except FileNotFoundError:
        print("    ERROR: Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code")
        return None
    except subprocess.TimeoutExpired:
        print("    Claude CLI timed out after 600s")
        return None
    except json.JSONDecodeError as e:
        print(f"    JSON parse error: {e}")
        return None
    except Exception as e:
        print(f"    Claude error: {e}")
        return None


# ── Per-rubric grading ──────────────────────────────────────────────


def grade_scoring_rubric(text, rubric, is_transcript, time_score=0):
    """Grade a scoring rubric and return structured results."""
    prompt = build_scoring_rubric_prompt(text, rubric, is_transcript)
    ai_result = call_claude(prompt)
    if not ai_result:
        return None

    scores_map = {r["id"]: r for r in ai_result.get("rubric_scores", [])}

    category_scores = {}
    total = 0
    max_total = 0

    for category in rubric.get("categories", []):
        cat_score = 0
        cat_max = category.get("max_points", 0)
        for item in category["items"]:
            if item.get("data_source") == "survey_time":
                cat_score += time_score
            elif item["id"] in scores_map:
                cat_score += scores_map[item["id"]].get("score", 0)
        category_scores[category["name"]] = cat_score
        total += cat_score
        max_total += cat_max

    return {
        "total_score": total,
        "max_score": max_total,
        "category_scores": category_scores,
        "rubric_scores": ai_result.get("rubric_scores", []),
        "overall_notes": ai_result.get("overall_notes", ""),
    }


def grade_checklist(text, checklist, is_transcript):
    """Grade a checklist and return structured results."""
    prompt = build_checklist_prompt(text, checklist, is_transcript)
    ai_result = call_claude(prompt)
    if not ai_result:
        return None

    items = ai_result.get("items", [])
    has_questions = any("question" in item for section in checklist.get("sections", []) for item in section["items"])
    field = "asked" if has_questions else "present"

    completed = sum(1 for item in items if item.get(field, False))
    total_items = sum(len(s["items"]) for s in checklist.get("sections", []))

    section_scores = {}
    items_map = {item["id"]: item for item in items}
    for section in checklist.get("sections", []):
        section_ids = [item["id"] for item in section["items"]]
        section_scores[section["name"]] = {
            "completed": sum(1 for sid in section_ids if items_map.get(sid, {}).get(field, False)),
            "total": len(section_ids),
        }

    return {
        "completed": completed,
        "total": total_items,
        "section_scores": section_scores,
        "items": items,
    }


# ── Main grading loop ──────────────────────────────────────────────


def grade_submission(transcript_path, metadata, rubrics, vignette_map, profiles):
    """Grade a single submission against all discovered rubrics."""
    uid, vignette_id, timestamp = parse_transcript_filename(transcript_path.name)

    # Read transcript
    with open(transcript_path) as f:
        transcript = f.read()

    # Look up profile
    vignette_info = vignette_map.get(vignette_id, {})
    profile_id = vignette_info.get("profileId")
    profile = profiles.get(profile_id, {}) if profile_id else {}

    # Calculate time
    time_score, duration_minutes = calculate_time_score(
        metadata.get("start"), metadata.get("end")
    )

    # Collect field data used by field-sourced rubrics
    field_data = {}
    for rubric_key, rubric in rubrics.items():
        source = rubric.get("source", "transcript")
        if source.startswith("field:"):
            field_name = source.split(":", 1)[1]
            val = metadata.get(field_name, "")
            if val and str(val).strip():
                field_data[field_name] = str(val).strip()

    # Build result
    result = {
        "uid": uid,
        "scenario": vignette_info.get("title", vignette_id),
        "vignette_id": vignette_id,
        "transcript_file": transcript_path.name,
        "submission_time": metadata.get("_submission_time"),
        "start_time": metadata.get("start"),
        "end_time": metadata.get("end"),
        "duration_minutes": duration_minutes,
        "time_score": time_score,
        "profile_id": profile_id,
        "profile": profile,
        "transcript": transcript,
        "field_data": field_data,
        "results": {},
        "graded_at": datetime.now().isoformat(),
    }

    # Grade each rubric
    for rubric_key, rubric in rubrics.items():
        source = rubric.get("source", "transcript")

        # Determine text to grade
        if source == "transcript":
            grade_text = transcript
            is_transcript = True
        elif source.startswith("field:"):
            field_name = source.split(":", 1)[1]
            grade_text = metadata.get(field_name, "")
            is_transcript = False
        else:
            print(f"    Unknown source '{source}' for {rubric_key}, skipping")
            continue

        if not grade_text or not str(grade_text).strip():
            print(f"    No text for {rubric_key} (source: {source}), skipping")
            continue

        print(f"    Grading {rubric_key} (source: {source})...")

        # Determine rubric type and grade accordingly
        if "categories" in rubric:
            rubric_result = grade_scoring_rubric(grade_text, rubric, is_transcript, time_score)
        elif "sections" in rubric:
            rubric_result = grade_checklist(grade_text, rubric, is_transcript)
        else:
            print(f"    Unknown rubric structure for {rubric_key}, skipping")
            continue

        if rubric_result:
            result["results"][rubric_key] = rubric_result

    return result


def build_index(project_name, rubrics, profiles, submissions_dir, output_path):
    """Build index.json from individual graded submission files."""
    submissions = []

    for json_path in sorted(submissions_dir.glob("*.json")):
        try:
            with open(json_path) as f:
                detail = json.load(f)

            summary = {
                "uid": detail.get("uid"),
                "scenario": detail.get("scenario"),
                "vignette_id": detail.get("vignette_id"),
                "transcript_file": detail.get("transcript_file"),
                "submission_time": detail.get("submission_time"),
                "duration_minutes": detail.get("duration_minutes"),
                "profile_id": detail.get("profile_id"),
                "results": {},
            }

            # Summarize each rubric's results
            for rk, rv in detail.get("results", {}).items():
                if "total_score" in rv:
                    summary["results"][rk] = {
                        "total_score": rv["total_score"],
                        "max_score": rv["max_score"],
                        "category_scores": rv.get("category_scores", {}),
                    }
                elif "completed" in rv:
                    summary["results"][rk] = {
                        "completed": rv["completed"],
                        "total": rv["total"],
                        "section_scores": rv.get("section_scores", {}),
                    }

            submissions.append(summary)
        except Exception as e:
            print(f"  Warning: Could not load {json_path}: {e}")

    # Deduplicate: keep latest per uid+vignette_id
    seen = {}
    for s in submissions:
        key = (s.get("uid"), s.get("vignette_id"))
        if key not in seen or (s.get("submission_time") or "") > (seen[key].get("submission_time") or ""):
            seen[key] = s
    submissions = list(seen.values())

    # Load project config for display name
    config = load_project_config(project_name)

    index = {
        "generated_at": datetime.now().isoformat(),
        "project_name": config.get("displayName", project_name),
        "total_submissions": len(submissions),
        "rubrics": {k: {kk: vv for kk, vv in v.items()} for k, v in rubrics.items()},
        "profiles": profiles,
        "submissions": submissions,
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(index, f, indent=2)

    print(f"Built index with {len(submissions)} submissions")
    return submissions


def main():
    parser = argparse.ArgumentParser(description="Grade submissions against discovered rubrics")
    parser.add_argument("--project", required=True, help="Project name")
    args = parser.parse_args()

    print("=" * 60)
    print(f"AI-MED Grader — {args.project}")
    print("=" * 60)

    # Load project config
    config = load_project_config(args.project)
    vignette_map = build_vignette_map(config)

    # Discover templates from vignettes
    templates = sorted(set(v.get("template") for v in config.get("cases", {}).get("vignettes", []) if v.get("template")))
    if not templates:
        print("No case templates found in project vignettes")
        return

    # Build vignette_id → template mapping
    vignette_template_map = {v["key"]: v["template"] for v in config.get("cases", {}).get("vignettes", [])}

    # Discover rubrics and profiles per template
    rubrics_by_template = {}
    profiles_by_template = {}
    all_rubrics = {}  # flat dict for index building

    print("\nDiscovering rubrics...")
    for template in templates:
        rubrics = discover_rubrics(args.project, template)
        if rubrics:
            rubrics_by_template[template] = rubrics
            all_rubrics.update(rubrics)
        profiles_by_template[template] = load_profiles(args.project, template)

    if not rubrics_by_template:
        print("No rubrics found in any template, nothing to grade.")
        return

    # Merge all profiles for index
    all_profiles = {}
    for p in profiles_by_template.values():
        all_profiles.update(p)

    # Paths
    work_dir = PROJECT_ROOT / "projects" / args.project / "eval" / "_work"
    submissions_meta_path = work_dir / "submissions.json"
    transcripts_dir = work_dir / "transcripts"
    output_dir = PROJECT_ROOT / "projects" / args.project / "eval" / "submissions"
    output_dir.mkdir(parents=True, exist_ok=True)

    # Load submission metadata
    if not submissions_meta_path.exists():
        print(f"No submissions metadata at {submissions_meta_path}")
        print("Run fetch_transcripts.py first.")
        # Still rebuild index from any existing submissions
        index_path = PROJECT_ROOT / "projects" / args.project / "eval" / "index.json"
        build_index(args.project, all_rubrics, all_profiles, output_dir, index_path)
        return

    with open(submissions_meta_path) as f:
        submissions_metadata = json.load(f)

    # Find transcripts to grade
    transcript_files = sorted(transcripts_dir.glob("*.txt")) if transcripts_dir.exists() else []
    print(f"\nFound {len(transcript_files)} transcript files")

    # Check which need grading (or re-grading for new rubrics)
    to_grade = []
    already_done = 0

    for tp in transcript_files:
        uid, vignette_id, _ = parse_transcript_filename(tp.name)
        template = vignette_template_map.get(vignette_id)
        rubrics = rubrics_by_template.get(template, {})
        if not rubrics:
            continue

        output_path = output_dir / f"{tp.stem}.json"
        if output_path.exists():
            # Check if all current rubrics are present in the graded file
            with open(output_path) as f:
                existing = json.load(f)
            existing_keys = set(existing.get("results", {}).keys())
            needed_keys = set(rubrics.keys())
            if needed_keys.issubset(existing_keys):
                already_done += 1
                continue
        to_grade.append(tp)

    print(f"Already graded: {already_done}")
    print(f"To grade: {len(to_grade)}")

    if to_grade:
        print("\nGrading...")
        for i, tp in enumerate(to_grade):
            uid, vignette_id, _ = parse_transcript_filename(tp.name)
            template = vignette_template_map.get(vignette_id)
            rubrics = rubrics_by_template.get(template, {})
            profiles = profiles_by_template.get(template, {})
            print(f"  [{i+1}/{len(to_grade)}] {tp.name} (template: {template})")

            # Find metadata
            metadata = None
            for sub in submissions_metadata:
                if str(sub.get("uid", "")) == uid and sub.get("vignette_id", "") == vignette_id:
                    metadata = sub
                    break

            if not metadata:
                print(f"    No metadata found, skipping")
                continue

            result = grade_submission(tp, metadata, rubrics, vignette_map, profiles)

            # Save
            output_path = output_dir / f"{tp.stem}.json"
            with open(output_path, "w") as f:
                json.dump(result, f, indent=2)

            # Print summary
            for rk, rv in result.get("results", {}).items():
                if "total_score" in rv:
                    print(f"    {rk}: {rv['total_score']}/{rv['max_score']}")
                elif "completed" in rv:
                    print(f"    {rk}: {rv['completed']}/{rv['total']}")

        print(f"\nGraded {len(to_grade)} submissions")

    # Rebuild index
    print("\nRebuilding index...")
    index_path = PROJECT_ROOT / "projects" / args.project / "eval" / "index.json"
    build_index(args.project, all_rubrics, all_profiles, output_dir, index_path)


if __name__ == "__main__":
    main()
