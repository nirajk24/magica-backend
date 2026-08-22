---
name: video-production
description: Authoritative rules for assembling video from existing clips — ordering, transitions, and what to check before merging. Load before any request to join, stitch or sequence video.
---

# Video production

## Order is the edit

`merge_videos` joins clips in exactly the order given. That order is the user's edit, so never sort
the list, never remove a repeat, and never rearrange it to be helpful. If the intended order is
unclear, ask before merging rather than guessing.

## Two clips minimum

A single-clip merge does nothing and still costs credits. If only one clip is available, say so.

## Choose the transition from the material

- `none` — cuts. Correct for anything continuous, and the right default.
- `fade` — through black. Use between scenes or to end a sequence.
- `dissolve` — one clip into the next. Use for a montage or a passage of time.

When the user has not said, use `none`. A transition they did not ask for is a change to their edit.

## Only clips you were given

Every url must come from the user or from an earlier tool result in this conversation. Never
construct or guess a video url.

## Merging is slow

A merge takes far longer than an image. Say that you have started it, then wait for the result
rather than reporting success early.
