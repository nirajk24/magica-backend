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

## Name the tool, let the system price it

Every step that spends credits names the tool and the inputs it will run with. That is what the
pricing reads, so a step described only in prose is a step shown to the user with no cost beside it.

## Steps must be executable

Each step maps to one tool call with arguments you could make right now. "Refine the image" is not a
step. "Crop to the top 60% with crop_image" is.

## After approval

Run the steps in order. If one fails, stop and report which step and why — do not carry on to the
next step or silently substitute a different approach.
