# Dream Analyser 🌙

A desktop dream journal (it runs in its own window, not a browser) that walks you through interpreting your dreams with a **local Ollama model**. It reads and writes **`.ld3`** dream files, so it works with your existing journal folders.

## Features

- **Journal tree.** Dreams are grouped by year, then month, from any folders you add (sub-folders are scanned too). It has search, a list of recent dreams and a few stats.
- **New dream form.** Title, date (filled in with today's date) and your recollection, plus optional time, sleep and wake times, lucidity and clarity.
- **Guided interpretation workflow.** Every AI step is a **fresh thread** that starts from no previous messages and gets only what it needs. This keeps small local models focused.
  1. **Extract.** One thread lists the dream's details in chronological order. A second thread converts that list to strict JSON (using Ollama's structured output), and the app parses it.
  2. **Ask.** For each detail, a new thread is given *only that detail* and writes one question that draws out your associations. Use **Different question** to get another one, or **Skip**.
  3. **Answer.** You reply. The AI does **not** respond. Instead, a new thread is given the detail, the question and your answer, and structures your answer into tidy notes. Those go into the **Notes** (editable at any time), then the next detail comes up.
  4. **Second pass** (optional, on by default). New leads that came up in your notes (people, memories, themes) are extracted into the same strict list. Anything already covered is dropped, and each new lead goes through steps 2–3.
  5. **Analyse.** Four separate threads each build one document from your notes: *Themes*, *Emotions*, *Key details & symbols* and *Waking-life connections*. These appear in the **Analysis** tab. **Re-run analysis** rebuilds them after you edit your notes.
  6. **Interpret.** A final thread writes the interpretation from the dream and the four analysis documents. It never gets the raw notes.
  7. **Discuss.** You can chat about the interpretation like a normal chatbot. **Compact** summarises everything before the last exchange, so the model then sees *interpretation → conversation summary → last user message → last reply*. **Rewrite interpretation** produces a new version from the discussion. Earlier versions are kept.
- **Lightened Dream compatible.** `.ld3` is the [Lightened Dream](https://github.com/lucidcode/Lightened-Dream) format. Lightened Dream also uses `.ld3` for files that aren't dreams (reality checks, readings, REM cycles, ignore lists, …). Those are hidden from the journal and listed under an *unsupported files* notice.
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
| Chat history, analysis documents and workflow progress | The app's user-data folder (`sessions/`), keyed by file path |
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
