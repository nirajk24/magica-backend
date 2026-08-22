---
name: media-planning
description: The required contract for proposing multi-step work and its cost before any of it runs. Load before proposing a plan, and whenever a request needs more than one billable tool call or asks what something will cost.
---

# Media planning

## When a plan is required

Propose a plan first when the work needs more than one billable tool call, or when the user has
asked what it will cost. A single image from a single prompt needs no plan — just make it.

## What a plan must contain

- **Title** — the finished thing, in a few words.
- **Overview** — one paragraph describing the result, not the process.
- **Steps** — one line each, in the order they will run. Every step that spends credits names the
  tool it will call.
- **Notes** — anything the user should know before agreeing, especially a limitation of the result.

## Never state a price yourself

You do not know what anything costs. Name the tool and its inputs for each step and the system
prices it. A number you invent will be wrong, and it will be shown to the user as if it were real.

## Steps must be executable

Each step maps to one tool call with arguments you could make right now. "Refine the image" is not a
step. "Crop to the top 60% with crop_image" is.

## After approval

Run the steps in order. If one fails, stop and report which step and why — do not carry on to the
next step or silently substitute a different approach.
