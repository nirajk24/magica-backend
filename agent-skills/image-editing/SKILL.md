---
name: image-editing
description: Authoritative rules for image work — the output-size table, when to crop rather than regenerate, and how to specify a crop rectangle correctly. Load before any request to create, resize, reframe or crop an image.
---

# Image editing

## Pick the size from the purpose, not from the user's words

Ask what the image is *for*, then choose from the sizes `gpt_image_2` accepts. Never invent a
dimension outside that list, and never pass `Custom`.

See `sizes.md` in this skill for the purpose-to-size table.

## Give `crop_image` a complete rectangle

Send all four percentage fields or all four pixel fields, never a mix. Percentages are measured from
the top-left corner, so "the top half" is `x_percent: 0, y_percent: 0, width_percent: 100,
height_percent: 50`.

If you only know the framing in words, work it out in percentages — pixel coordinates need the
image's real dimensions, which you do not have.

## Reframing an existing image

Judge whether the framing alone is wrong or the picture is. Only the framing — crop it. The subject,
style or content — regenerate. A crop cannot add anything that is not already in the frame.
