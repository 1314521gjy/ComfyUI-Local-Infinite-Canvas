---
name: h3-prompt-writing
description: Write MiniMax H3 video generation prompts for T2VA, I2VA, FL2VA, L2VA, and Ref2VA. Use when rewriting multimodal requests into H3 prompt structures, composing integrated_multimodal_description, overall_soundscape, and non_diegetic_music, aligning keyframes, or defining reference labels for images, videos, and audio.
compatibility: Portable to any agent that can read local files — no external API calls, MiniMax Hub tools, or proprietary runtime required. The agents/openai.yaml file only adds optional ChatGPT/Codex UI metadata; it does not restrict the skill to OpenAI agents.
---

# H3 Prompt Writing

## Workflow

1. Identify the input mode: T2VA, I2VA, FL2VA, L2VA, or full-reference Ref2VA.
2. For base text/keyframe modes, read `references/base-en.txt` and follow its final prompt structure.
3. For full-reference mode, read `references/ref-en.txt` and follow its six-section rewrite format.
4. Preserve the exact field names, section order, labels, and timing notation from the selected guide.

## Base Modes

- T2VA: build the full audiovisual timeline from text.
- I2VA: start from the first frame and develop forward from it.
- FL2VA: describe the continuous path between the first and last frames.
- L2VA: infer a plausible opening and converge to the supplied last frame.

Use `integrated_multimodal_description`, `overall_soundscape`, and `non_diegetic_music` in the order shown in `references/base-en.txt`.

## Full-Reference Mode

Ref2VA rewrites use `subject_definitions`, `summary`, `retention_analysis`, `detailed_description`, `overall_soundscape`, and `non_diegetic_music` in that order. Reference labels stay consistent across all sections.

Read `references/ref-en.txt` for label rules, retention analysis, and complete examples.

## Output Rules

- Write rewrite sections in English; preserve dialogue, lyrics, and visible scene text in their original language.
- Describe each shot by composition, subjects, environment, actions, camera, sound, and the exact point where referenced content appears.
- Avoid plot summaries, unresolved reference labels, and timing that does not match the requested duration.

## Local H3 Compatibility Rules (VDN / cfg=1)

These apply when the prompt runs through the bundled local H3 workflows (`cfg=1` with `ConditioningZeroOut`). Keep the official section structure above unchanged; only adjust wording.

1. **Describe positively.** With `cfg=1`, negation tokens (`no`, `not`, `without`, `avoid`) still enter the positive conditioning as ordinary tokens and may reinforce what they name. Rewrite the description as a positive fact:
   - `no blood` → `clean, intact, unretouched skin`
   - `no other people` → `stands alone in an empty, quiet corridor`
   Apply this to descriptive text only. Never rewrite dialogue, lyrics, narration inside `<d>` tags, or visible scene text; do not run a blanket find-and-replace.
2. **Anchor references explicitly.** When reference images are supplied, state where identity, costume, and setting come from using the exact labels `<Picture 1>`, `<Picture 2>`, and so on. Only a text-only T2VA prompt with no image inputs must avoid fabricating `Picture` labels; I2VA, FL2VA, L2VA, and Ref2VA must reference their real keyframe or reference inputs with the matching labels.
3. **Honor the requested shot continuity.** If the user asks for one continuous take or no cuts, say so positively in the description, for example `one continuous locked-off shot from a tripod`. If the user asks for cuts or multiple shots, follow that intent and do not force a locked-off camera.
4. **Prefer concrete craft over generic praise.** Describe light position, color temperature, lens, material, and motion. Do not stack `cinematic, photorealistic, 8k, masterpiece`-style filler; do not ban `cinematic` outright — the official style field still uses it.

## Tips for Better Results
- Always match the total duration of the description to the requested video length (4–15 seconds).
- Keep reference labels consistent (e.g. `<Picture 1>`, `<Video 1>`, `<Audio 1>`) across every section.
- Prefer concrete visual and audio details over abstract words like "cinematic" or "beautiful".
- When using keyframes (I2VA / FL2VA / L2VA), clearly state how the first and/or last frame connects to the timeline.
