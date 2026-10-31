# Dream Analyser 🌙

A desktop dream journal (it runs in its own window, not a browser) that walks you through interpreting your dreams with a **local Ollama model**. It reads and writes **`.ld3`** dream files, so it works with your existing journal folders.

## Features

- **Journal tree.** Dreams are grouped by year, then month, from any folders you add (sub-folders are scanned too). It has search, a list of recent dreams and a few stats.
- **New dream form.** Title, date (filled in with today's date) and your recollection, plus optional time, sleep and wake times, lucidity and clarity.
- **Guided interpretation workflow:**
  1. The AI lists the dream's details in chronological order.
  2. A second call converts that list to strict JSON (using Ollama's structured output), and the app parses it.
  3. Chat on the left, notes on the right. The AI goes through **each detail one at a time** and asks what it reminds you of and what it means to you. When it decides a detail has been covered it moves on by itself. You can also click **Next detail** or **Skip** at any time.
  4. After each detail, your answers are summarised into bullet points and added to the **Notes**. The notes are editable at any time.
  5. When the first list is finished, the AI turns your notes into the same strict detail list of **new threads** (people, memories and themes that came up). Duplicates of details you've already covered are dropped, and you're walked through the new ones.
  6. Finally the notes are compiled into a **dream interpretation**, shown in its own tab (switch between **Dream / Notes / Interpretation**).
  7. **Discuss the interpretation.** Challenge it, add context, and the AI revises it, or click **Rewrite interpretation**. Earlier versions are kept, so you can go back to one.
- **Pick a model** from the top bar. The model list comes from your Ollama install.
- Everything is **saved as you go**. You can close a dream partway through and resume later.

## Requirements

- [Node.js](https://nodejs.org/) 18 or newer
- [Ollama](https://ollama.com/) running locally, with at least one chat model installed, e.g.

  ```bash
  ollama pull llama3.1
  ```

  Larger or instruction-tuned models (e.g. `llama3.1:8b`, `qwen2.5:14b`, `gemma2:9b`, `mistral-nemo`) follow the workflow best. Models that "think" (deepseek-r1, qwen3) also work. Their reasoning is hidden.

## Run it

```bash
npm install
```

```bash
npm start
```

### Build a standalone app (optional)

```bash
npm run dist
```

This creates an installer in `dist/` for your current OS (`.exe` on Windows, `.dmg` on macOS, `.AppImage` on Linux). It also registers `.ld3` files with the app.

## Settings

Click ⚙ in the top-right:

- **Ollama server address.** Defaults to `http://127.0.0.1:11434`.
- **Model** and **creativity** (temperature).
- **Dream folders.** Add as many as you like. ★ marks the folder new dreams are saved into. If you haven't added any folders, new dreams go to `Documents/Dreams`.

## How data is stored

| What | Where |
|---|---|
| Dream fields (date, title, recollection, …) | The `.ld3` file |
| Notes + final interpretation | The `.ld3` file's `<Comments>` field. Notes come first, then a `==== Dream Interpretation ====` line, then the interpretation |
| Chat history and workflow progress | The app's user-data folder (`sessions/`), keyed by file path |
| Settings | The app's user-data folder (`settings.json`) |

When the app saves an **existing** `.ld3` file, it only edits the fields it knows about. Everything else is left as it was: unknown elements, `SubCategories` content, line endings (CRLF/LF) and the file's encoding (UTF-8, UTF-8 with BOM, or UTF-16). New files are named `YYYY-MM-DD Title.ld3` and follow this layout:

```xml
<Dream>
  <Date>2026-10-10</Date>
  <Time>04:20</Time>
  <Sleep>23:30</Sleep>
  <Awake>06:30</Awake>
  <Title>title goes here</Title>
  <Lucidity>1-5</Lucidity>
  <Dream>initial dream recording</Dream>
  <Comments>notes go here</Comments>
  <Clarity>1-5</Clarity>
  <SubCategories>
  </SubCategories>
  <Image></Image>
</Dream>
```

## Keyboard shortcuts

| Keys | Action |
|---|---|
| `Enter` / `Shift+Enter` | Send message / new line |
| `Ctrl+Enter` (in the form) | Save and start interpreting |
| `Ctrl+N` (journal) | New dream |
| `Ctrl+S` | Save now |

## Development

```bash
npm test
```

The tests cover `.ld3` parsing and writing, folder scanning, and detail-list parsing.

Project layout:

```
src/main/       Electron main process: window, IPC, .ld3 I/O, Ollama client, settings
src/preload.js  Safe bridge between the main process and the UI
src/renderer/   UI (HTML/CSS/vanilla JS); js/app.js holds the workflow, js/prompts.js the prompts
test/           Node unit tests
```
