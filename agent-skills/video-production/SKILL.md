---
name: video-production
description: Authoritative rules for assembling video from existing clips — ordering, transitions, and what to check before merging. Load before any request to join, stitch or sequence video.
---

# Video production

## Work out the order before you ask for it

The order is the edit, and `merge_videos` enforces that. What this skill adds is how to arrive at
it: a sequence the user described in words ("the sunset one last") is yours to resolve against the
clips you have, and a sequence you cannot resolve is one to ask about rather than guess.

## Two clips minimum

A single-clip merge does nothing and still costs credits. If only one clip is available, say so.

## Choose the transition from the material

- `none` — cuts. Correct for anything continuous, and the right default.
- `fade` — through black. Use between scenes or to end a sequence.
- `dissolve` — one clip into the next. Use for a montage or a passage of time.

When the user has not said, use `none`. A transition they did not ask for is a change to their edit.

## Merging is slow

A merge takes far longer than an image. Say that you have started it, then wait for the result
rather than reporting success early.
