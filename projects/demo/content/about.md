# About this demo

This is the synthetic demo project that ships with AI-MED Core. It exists so that
a fresh clone of the repository boots into a working application you can click
through, without needing any clinical content, any KoboToolbox form, or any
credentials beyond an OpenAI API key.

## What is fake here

All of it. The patient, the case, the scripted answers, and the examination
findings were invented for software testing. There is no real encounter behind
them, no clinical review, and no approved curriculum. Nothing on this screen or
in the conversation is medical advice.

## What the demo shows

- A vignette loaded from `projects/demo/` and served through the chat API.
- A model staying in character as a patient and releasing examination findings
  only when the provider asks for them.
- The transcript being captured as the conversation proceeds.
- A project-defined tab, which is the panel you are reading now.

## What the demo deliberately leaves out

This project is configured with `"formless": true`, so there is no KoboToolbox
assessment form and no grading. That keeps the first run free of external
dependencies. A real project turns the form on, points at its own deployed Kobo
form, and supplies a scoring rubric and an assessment checklist.

## Building your own project

Copy the shape of `projects/demo/`, then read `CREATING-A-PROJECT.md`. Two things
that are yours to supply and that the demo cannot supply for you: your own case
content, and your own IRB-approved informed consent text.
