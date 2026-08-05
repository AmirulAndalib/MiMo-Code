---
feature: tui-quiet-mode
status: in-progress
updated: 2026-08-05
branch: feature/tui-quiet-mode
commits:
---

# TUI Quiet Mode

## Report

## [S1] Problem

The current vivid presentation redraws the home screen for stars, meteors, and logo sweeps and uses elaborate animated progress indicators. The persisted "Disable animations" option only stops some shared spinners, so it cannot represent a quiet default visual style or reliably stop high-frequency cosmetic refreshes.

## [S2] Design

Add an independent KV-backed `visual_mode` preference with `minimal` and `vivid` values. It is switched from the command palette, persists across launches, and defaults to `minimal`. The existing `animations_enabled` preference remains a separate accessibility and performance override.

In `minimal` mode:

- The default home background is empty: no star field and no meteors. A user-selected static background image remains visible.
- The home logo does not start automatic sweep or interaction animation timers.
- Prompt busy state uses a compact static status bar derived from the original opencode-style indicator, with no UFO glyph or timer.
- In-progress tasks, workflows, and agents use stable status glyphs rather than spinners.

In `vivid` mode, current visuals remain available. When animations are also disabled, vivid visuals become static: the star field may remain, but twinkling, meteors, logo motion, and animated progress indicators stop. Low-frequency functional updates such as home tip rotation and retry countdowns remain active in every combination. Streaming message updates and streaming-only telemetry may continue to redraw while model output is arriving.

The implementation must use the existing theme colors, dimensions, and layout; this is an existing-codebase motion change, not a new visual language.

## [S3] Out of Scope

- Adding a CLI startup flag, a `tui.json` setting, or changing the default value of the existing animation preference.
- Disabling bounded interaction feedback, home tip rotation, retry behavior, autocomplete polling, or other functional timers.
- Redesigning the home layout, logo artwork, theme, or sidebar structure.

## Tasks

- [ ] T1: Add the persisted visual mode command — acceptance: the command palette switches between `minimal` and `vivid`, persists the choice, and an unset value resolves to `minimal` (covers: S2)
- [ ] T2: Apply visual and animation preferences to passive home motion — acceptance: minimal mode has no default celestial background or logo motion; vivid mode preserves current visuals; disabling animations leaves vivid visuals static and preserves functional tip rotation (covers: S2; depends: T1)
- [ ] T3: Stabilize every in-progress indicator — acceptance: prompt, task, workflow, and agent running states render fixed-width static markers unless both vivid mode and animations are enabled (covers: S2; depends: T1)
- [ ] T4: Add focused regression coverage and verify TUI behavior — acceptance: tests cover preference resolution and relevant package tests and typecheck pass (covers: S2; depends: T1, T2, T3)
