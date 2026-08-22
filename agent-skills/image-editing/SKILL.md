---
name: image-editing
description: Authoritative rules for image work — the output-size table, when to crop rather than regenerate, and how to specify a crop rectangle correctly. Load before any request to create, resize, reframe or crop an image.
---

# Image editing

## Pick the size from the purpose, not from the user's words

Ask what the image is *for*, then choose from the sizes `gpt_image_2` accepts. Never invent a
dimension outside that list, and never pass `Custom`.

See `sizes.md` in this skill for the purpose-to-size table.

## Crop before you generate, never after

If the user supplies an image and wants it reframed, crop it first and pass the result on. Cropping a
generated image wastes the generation, because `gpt_image_2` is billed per image and `crop_image`
is not.

## Give `crop_image` a complete rectangle

Send all four percentage fields or all four pixel fields, never a mix. Percentages are measured from
the top-left corner, so "the top half" is `x_percent: 0, y_percent: 0, width_percent: 100,
height_percent: 50`.

If you only know the framing in words, work it out in percentages — pixel coordinates need the
image's real dimensions, which you do not have.

## One image at a time

Leave `n` at 1 unless the user explicitly asks for variations. Each extra image is charged in full.

## Describe, then stop

After a successful generation, say in one line what was made. Do not restate the prompt, and do not
write the file's URL — the interface shows the image.
