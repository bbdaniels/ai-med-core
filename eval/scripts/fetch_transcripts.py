"""
AI-MED Transcript Fetcher

Fetches KoboToolbox submissions for a project. Transcripts are stored directly
in the Kobo chat_transcript field (written by the backend after form submission).
Filters out submissions with empty or near-empty transcripts.

Usage:
    python fetch_transcripts.py --project demo [--after 2026-01-08]
"""

import os
import json
import argparse
import requests
import pandas as pd
from pathlib import Path
from datetime import datetime

# Configuration
KOBO_API_TOKEN = os.getenv("KOBO_API_TOKEN")
KOBO_SERVER = os.getenv("KOBO_SERVER", "kf.kobotoolbox.org")

PROJECT_ROOT = Path(__file__).parent.parent.parent  # ai-med/

MIN_TRANSCRIPT_LENGTH = 100
MIN_USER_MESSAGES = 1


def load_project_config(project_name):
    """Load project.json for the given project."""
    config_path = PROJECT_ROOT / "projects" / project_name / "project.json"
    with open(config_path) as f:
        return json.load(f)


def fetch_submissions(form_uid):
    """Fetch all submissions from KoboToolbox API."""
    if not KOBO_API_TOKEN:
        raise ValueError("KOBO_API_TOKEN environment variable must be set")

    print(f"Fetching from Kobo API: {KOBO_SERVER} (form {form_uid})")
    headers = {"Authorization": f"Token {KOBO_API_TOKEN}"}
    url = f"https://{KOBO_SERVER}/api/v2/assets/{form_uid}/data/?format=json"

    all_results = []
    while url:
        response = requests.get(url, headers=headers, timeout=60)
        response.raise_for_status()
        data = response.json()
        all_results.extend(data.get("results", []))
        url = data.get("next")
        if url:
            print(f"  Fetched {len(all_results)} submissions, getting more...")

    print(f"Total submissions from API: {len(all_results)}")
    return pd.DataFrame(all_results)


def filter_by_date(df, after_date):
    """Filter out submissions before the given date."""
    df["_submission_time"] = pd.to_datetime(df["_submission_time"])
    filtered = df[df["_submission_time"] >= after_date].copy()
    print(f"After date filter (>= {after_date}): {len(filtered)}")
    return filtered


def count_user_messages(transcript):
    """Count user messages in a transcript."""
    if not transcript:
        return 0
    return transcript.count("\nUser:\n") + transcript.count("\nUser: ")


def extract_transcripts(df):
    """Extract transcripts from Kobo field and filter out empty/invalid ones.

    The chat_transcript field contains the full transcript text (written by the
    backend after form submission).  Submissions where the write failed will
    contain only a short hex token — these are filtered out by MIN_TRANSCRIPT_LENGTH.
    """
    df = df.copy()
    df["transcript_text"] = df["chat_transcript"].where(
        df["chat_transcript"].notna(), other=None
    )

    before = len(df)
    df = df[df["transcript_text"].notna()].copy()
    df = df[df["transcript_text"].str.len() >= MIN_TRANSCRIPT_LENGTH].copy()

    df["user_message_count"] = df["transcript_text"].apply(count_user_messages)
    df = df[df["user_message_count"] >= MIN_USER_MESSAGES].copy()

    print(f"After transcript filtering: {len(df)} valid (removed {before - len(df)})")
    return df


def save_output(df, output_dir):
    """Save transcripts and metadata to output directory."""
    transcripts_dir = output_dir / "transcripts"
    transcripts_dir.mkdir(parents=True, exist_ok=True)

    for _, row in df.iterrows():
        uid = row.get("uid", "unknown")
        vignette = row.get("vignette_id", "unknown")
        submission_time = row["_submission_time"].strftime("%Y%m%d_%H%M%S")

        filename = f"{uid}_{vignette}_{submission_time}.txt"
        filepath = transcripts_dir / filename

        with open(filepath, "w") as f:
            f.write(row["transcript_text"])

    # Save metadata (without full transcript text)
    meta_df = df.copy()
    meta_df["_submission_time"] = meta_df["_submission_time"].astype(str)
    if "start" in meta_df.columns:
        meta_df["start"] = meta_df["start"].astype(str)
    if "end" in meta_df.columns:
        meta_df["end"] = meta_df["end"].astype(str)

    records = meta_df.drop(columns=["transcript_text", "user_message_count"], errors="ignore").to_dict(orient="records")
    with open(output_dir / "submissions.json", "w") as f:
        json.dump(records, f, indent=2)

    print(f"Saved {len(df)} transcripts to {transcripts_dir}")


def main():
    parser = argparse.ArgumentParser(description="Fetch Kobo submissions and transcripts")
    parser.add_argument("--project", required=True, help="Project name (e.g., demo)")
    parser.add_argument("--after", help="Only include submissions after this date (YYYY-MM-DD)")
    args = parser.parse_args()

    print("=" * 60)
    print(f"AI-MED Transcript Fetcher — {args.project}")
    print("=" * 60)

    # Load project config
    config = load_project_config(args.project)
    form_uid = config["kobo"]["formUid"]
    print(f"Kobo form: {form_uid}")

    # Fetch submissions
    df = fetch_submissions(form_uid)
    if df.empty:
        print("No submissions found.")
        return

    # Date filter
    if args.after:
        df = filter_by_date(df, args.after)

    # Skip submissions marked as not_approved in Kobo
    if "_validation_status" in df.columns:
        before = len(df)
        df = df[df["_validation_status"].apply(
            lambda v: not (isinstance(v, dict) and v.get("uid") == "validation_status_not_approved")
        )].copy()
        rejected = before - len(df)
        if rejected:
            print(f"Skipped {rejected} rejected submissions (validation_status=not_approved)")

    # Extract and filter transcripts from Kobo field data
    # Ensure submission time is datetime
    df["_submission_time"] = pd.to_datetime(df["_submission_time"])

    print("\nFiltering transcripts...")
    df = extract_transcripts(df)

    if df.empty:
        print("No valid transcripts after filtering.")
        return

    # Save to working directory
    output_dir = PROJECT_ROOT / "projects" / args.project / "eval" / "_work"
    save_output(df, output_dir)

    # Summary
    print(f"\nValid submissions: {len(df)}")
    if "vignette_id" in df.columns:
        print(f"Vignettes: {df['vignette_id'].value_counts().to_dict()}")


if __name__ == "__main__":
    main()
