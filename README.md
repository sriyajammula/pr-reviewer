# PR Reviewer (VS Code Extension)
## Privacy-first AI code reviewer that analyzes your local git changes and shows a summary + actionable issues inside VS Code. Works offline with Ollama (local models), with optional support for your own API/gateway later.

https://github.com/sriyajammula/pr-reviewer

## Features
- One-click review: Command Palette → AI Review: Review Current Changes
- AI Review panel: Summary + grouped issues with severity and Open buttons to jump to code
- Inline diagnostics (optional): Issues also appear in VS Code’s Problems panel
- Acceptance criteria aware: Reads .ai-review/spec.yml or ad-hoc criteria you paste
- Privacy-first: Default path uses local LLM via Ollama; no code leaves your machine
- Configurable model: Choose any Ollama model (e.g. qwen2.5-coder:14b, llama3.1:8b)

## Requirements
- Git installed and repo with local changes (git diff must not be empty).
- Ollama running locally (default mode).
  - Install: brew install ollama
  - Start: ollama serve
  - Pull a model (pick one your machine can handle):
```
ollama pull qwen2.5-coder:14b\
#or: ollama pull llama3.1:8b
```
- In VS Code Settings, set AI Reviewer: Model to the model you pulled.

## Quickstart
- Open your project in VS Code and make a small edit (so git diff isn’t empty).
- Ensure Ollama is running and your model is pulled.
- Press ⌘⇧P / Ctrl+Shift+P → AI Review: Review Current Changes.
- Read the AI Review panel; click Open on any issue to jump to the code.

## Acceptance Criteria (optional but recommended)
- Create .ai-review/spec.yml at the root of your repo:
```
title: "Checkout: add promo code"
criteria:
  - "Given valid code, total reflects discount before payment"
  - "Invalid code shows inline error; no server 5xx"
non_goals:
  - "Cart redesign"
budgets:
  latency_p95_ms: 5
```
- If the file isn’t present, the extension will prompt you to paste criteria before a review.

