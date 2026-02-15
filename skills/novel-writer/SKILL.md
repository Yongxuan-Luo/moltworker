---
name: novel-writer
description: Bilingual (English/中文) novel-writing skill based on Novel Writer's SDD workflow. Use it to design a story spec, plan chapters, draft scenes, and run consistency checks.
user-invocable: true
homepage: https://github.com/wordflowlab/novel-writer
---

# Novel Writer (EN/中文) — Spec-Driven Novel Writing

This skill adapts the **Novel Writer** project (specification-driven development for novels) into a single chat-friendly workflow that supports **both English and Chinese** writing.

## How to Invoke (Telegram)

- **Direct command** (recommended): `/novel_writer ...`
- **Canonical fallback**: `/skill novel-writer ...` (skill key)
- **Compatibility fallback**: `/skill novel_writer ...`

Note: skill folder/key uses `novel-writer` (hyphen) but chat commands are sanitized to `novel_writer` (underscore).

## Language Support (Best Practice)

The skill supports:
- **English** (`lang: en`)
- **中文** (`lang: zh`)
- **Auto** (`lang: auto`, default): reply in the same language as the user input.
- **Bilingual output** (`bilingual: true`): produce the primary output, then a faithful translation.

If the user doesn’t specify language, infer it from the input. If mixed, ask: “Output in English or 中文?”

## Input Format (Copy/Paste)

You can paste free-form text, or use this mini-header (recommended):

```text
lang: auto|en|zh
step: constitution|specify|clarify|plan|tasks|write|analyze
method: (optional) three-act|hero-journey|story-circle|seven-point|pixar|snowflake
platform: (optional, for tone) webnovel|wattpad|medium|reddit|other
bilingual: true|false
glossary: true|false
genre:
audience:
length: (e.g. short story / 80k words / 30万字连载)
constraints: (rating/content limits, POV, tense, style)
material: (your premise / outline / chapter draft / notes)
```

## The 7-Step SDD Workflow (What Each Step Produces)

When `step` is missing, ask 1–3 questions, then recommend the next step.

### Quick Questions (Ask Only What’s Missing)

- **constitution**: themes/values, “must-have / must-not”, tone, POV preference, update cadence, content boundaries.
- **specify**: genre + subgenre, setting, protagonist goal, core conflict, target length, target reader, unique hook.
- **clarify**: POV/tense, magic/tech rules, character motivations, stakes escalation, ending type, taboo topics.
- **plan**: structure method (optional), major beats, key twists, arc per main character, chapter/episode count.
- **tasks**: current progress, next milestone, deliverable granularity (chapter vs scene), due date (if any).
- **write**: scene objective, POV character, location/time, desired word count, style constraints, what must happen.
- **analyze**: what to check (continuity/pacing/voice/logic), “golden opening” needs, whether to propose rewrites.

1) **constitution** — Creative constitution (non‑negotiable principles)
- Output: principles + quality bar + style rules + reader promise.

2) **specify** — Story specification (what you’re building)
- Output: one‑line pitch, logline, genre promise, themes, stakes, target length, success criteria, constraints, risks.

3) **clarify** — Key decisions (resolve ambiguity early)
- Output: decision list + options + recommendation + rationale + “open questions”.

4) **plan** — Creative plan (how to realize the spec)
- Output: story beats, character arcs, world rules, chapter/episode structure, pacing plan.

5) **tasks** — Actionable writing tasks
- Output: checklist per chapter/scene (goal, conflict, turn, payoff, continuity checks).

6) **write** — Draft scenes/chapters
- Output: prose in the requested language and style, with clear scene objectives and hooks.

7) **analyze** — Consistency + quality verification
- Output: continuity issues (timeline/character/world), style drift, pacing, hooks, payoff, and concrete rewrites.

## English vs 中文: What Changes (So It Doesn’t Feel Translated)

### If writing in English
- Prefer **tight paragraphing**, strong topic sentences, and varied sentence length.
- Dialogue: use **“ ”**, keep tags light, and avoid over-explaining emotion that can be shown via action.
- Avoid Chinese-style four-character idioms unless character voice demands it.

### If writing in 中文
- Prefer **自然中文**（避免“翻译腔”）：少用生硬倒装、少用英文式从句堆叠。
- 对话：中文网络小说常用 **“……”**、短句、强节奏；分段更频繁更利于阅读。
- 叙述节奏：更依赖“情绪推进 + 细节锚点”，避免每段都塞满抽象概念。

### Names, terms, and consistency
- Maintain a **glossary**: character names, places, items, special terms.
- If bilingual is requested, keep names consistent (don’t translate proper nouns unless asked).

## Writing in One Language From Material in the Other (Localization)

If the input material is mostly Chinese but `lang: en` (or vice versa), do **localization**, not literal translation:
- Preserve plot facts and character intent, but adapt idioms, metaphors, and dialogue rhythm to the target language.
- Ask whether to **keep proper nouns** as-is, romanize (pinyin), or localize (e.g., “青云山” → “Qingyun Mountain” vs “Azure Cloud Mountain”).
- If `glossary: true`, output a small glossary table first, then the draft/spec.

## Output Rules

- Always start with a short **Summary / 摘要** (3–6 bullets max).
- Use headings that match the requested language.
- If the user provides an existing draft, prioritize **surgical edits** over full rewrites unless asked.

## Notes (About the Upstream Project)

This skill is inspired by the open-source project Novel Writer (MIT licensed) and its SDD workflow, but is designed to be usable directly in chat without requiring any CLI setup.
