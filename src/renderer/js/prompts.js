'use strict';
/*
 * Prompt templates. Every function returns the complete message list for ONE
 * fresh thread: no step ever sees another step's conversation. Each thread is
 * given only the minimum it needs for its single job, which keeps small local
 * models on task.
 */
(function () {
  const DETAIL_SCHEMA = {
    type: 'object',
    properties: {
      details: {
        type: 'array',
        items: {
          type: 'object',
          properties: { title: { type: 'string' }, description: { type: 'string' } },
          required: ['title', 'description'],
        },
      },
    },
    required: ['details'],
  };

  const clip = (s, n) => {
    s = String(s || '');
    return s.length > n ? `…${s.slice(-n)}` : s;
  };

  const dreamBlock = (dream) =>
    `Dream title: ${dream.title || 'Untitled'}\n\nThe dreamer's recollection:\n"""\n${dream.text}\n"""`;

  /* ---------------- 1. Detail extraction ---------------- */

  /** Free-form chronological list of details from the dream text. */
  function listDetails(dream) {
    return [
      {
        role: 'system',
        content: 'You are a meticulous dream-work assistant. You extract details from dream reports precisely and never interpret them.',
      },
      {
        role: 'user',
        content: `${dreamBlock(dream)}

Break this dream into its distinct details: settings and places, people and beings, objects, actions and events, feelings and sensations, colours, sounds, words spoken, and anything odd or striking.

Order them chronologically — in the order they happen in the dream. Write one detail per line as a numbered list in exactly this form:
1. Short title — one sentence describing the detail, using the dreamer's own words where possible

Aim for roughly 5–12 details; merge trivial ones together. Do not interpret anything. Output only the list.`,
      },
    ];
  }

  /** Second pass: new leads (people, memories, themes) that surfaced in the notes. */
  function listNewLeads(notes, covered) {
    return [
      {
        role: 'system',
        content: 'You are a meticulous dream-work assistant. You extract items from notes precisely and never interpret them.',
      },
      {
        role: 'user',
        content: `A dreamer wrote these notes while thinking about the details of a dream:
"""
${clip(notes, 8000)}
"""

These dream details have ALREADY been explored:
${covered.map((t, i) => `${i + 1}. ${t}`).join('\n')}

List the NEW things that came up in the notes and are worth exploring on their own: real people, memories, places or situations from waking life, strong feelings, recurring themes. Do not repeat the already-explored details. Order them as they appear in the notes.

Write one per line as a numbered list in exactly this form:
1. Short title — one sentence describing it, using the dreamer's own words where possible

Aim for 2–6 items. If there is genuinely nothing new, output only the word NONE.`,
      },
    ];
  }

  /** Convert a free-form list into strict JSON the app can parse. */
  function strictify(list) {
    return [
      { role: 'system', content: 'You convert text into strict JSON. You output JSON only, with no commentary.' },
      {
        role: 'user',
        content: `Convert the following numbered list into JSON with exactly this shape:
{"details":[{"title":"...","description":"..."}]}

Rules:
- Keep the original order and include every item.
- "title" is short (2–6 words); "description" is the rest of the line.
- If the list is empty or just says NONE, return {"details":[]}.

List:
${list}`,
      },
    ];
  }

  /* ---------------- 2. Per-detail question (fresh thread, sees ONLY the detail) ---------------- */

  function askAboutDetail(detail, { lead = false, avoid = [] } = {}) {
    const kind = lead ? 'something that came up while they reflected on their dream' : 'one detail from their dream';
    return [
      {
        role: 'system',
        content: `You help a person explore ${kind}. Your only job is to ask them ONE short, open, warm question that draws out their personal associations with it — for example what it reminds them of, how it felt, what it means to them, or who or what in their waking life it connects to. Never interpret it yourself. Output only the question, optionally preceded by one short sentence naming the detail.`,
      },
      {
        role: 'user',
        content: `${lead ? 'Item' : 'Dream detail'}: "${detail.title}" — ${detail.description}${
          avoid.length ? `\n\nAsk something different from these earlier questions:\n${avoid.map((q) => `- ${q}`).join('\n')}` : ''
        }`,
      },
    ];
  }

  /* ---------------- 3. Structure the answer into notes (fresh thread) ---------------- */

  function structureAnswer(detail, question, answer) {
    return [
      {
        role: 'system',
        content: 'You turn what a dreamer said into clear, well-organised journal notes. You write in the first person, as the dreamer. You never add interpretation or anything they did not say.',
      },
      {
        role: 'user',
        content: `Dream detail: "${detail.title}" — ${detail.description}
Question they were asked: ${question}

Their answer:
"""
${answer}
"""

Rewrite their answer as 1–6 concise bullet points that capture every association, memory, feeling, person and insight they mentioned, in a coherent order. Keep their meaning and wording where possible. Output only the bullet points, each starting with "- ".`,
      },
    ];
  }

  /* ---------------- 4. Analysis documents (one fresh thread each, built from the notes) ---------------- */

  const ANALYSES = [
    {
      key: 'themes',
      title: 'Themes',
      task: 'Identify the main THEMES and patterns running through the dream and the dreamer\'s associations (e.g. loss of control, being tested, longing for home). For each theme, give it a short name and one line on where it shows up.',
    },
    {
      key: 'emotions',
      title: 'Emotions',
      task: 'List the EMOTIONS present — both those felt inside the dream and those stirred up by the dreamer\'s associations. For each, say where it came from and how strong it seemed.',
    },
    {
      key: 'symbols',
      title: 'Key details & symbols',
      task: 'Pick the 3–7 most IMPORTANT dream details or symbols (the most vivid, emotionally charged or strange ones). For each, summarise what it personally means or connects to for the dreamer, using their own associations.',
    },
    {
      key: 'waking',
      title: 'Waking-life connections',
      task: 'List the connections to the dreamer\'s WAKING LIFE: real people, current situations, memories, worries or hopes that came up. For each, note which part of the dream it is linked to.',
    },
  ];

  function analysis(spec, dream, notes) {
    return [
      {
        role: 'system',
        content: 'You are a careful dream-work analyst. You extract one specific kind of information from a dreamer\'s notes, faithfully and concisely, using their own associations rather than generic dream-dictionary meanings.',
      },
      {
        role: 'user',
        content: `${dreamBlock(dream)}

The dreamer's notes from exploring the dream:
"""
${clip(notes, 9000)}
"""

Task: ${spec.task}

Output a short Markdown bullet list only, no heading and no preamble.`,
      },
    ];
  }

  /* ---------------- 5. Final interpretation (fresh thread, sees only the analysis documents) ---------------- */

  const INTERP_FORMAT = `Write in Markdown, speaking directly to the dreamer ("you"), with these sections:
## Overview
2–3 sentences capturing the heart of the dream.
## Key symbols
What the most important details seem to represent for the dreamer.
## Themes & connections
How the pieces fit together and connect to their waking life.
## What the dream may be saying
## Questions to sit with
2–4 reflective questions.

Be specific and personal, tentative where appropriate ("this may suggest…"), and base everything on the analysis provided.`;

  const INTERP_SYSTEM =
    'You are an insightful, compassionate dream interpreter. You ground every interpretation in the dreamer\'s own associations.';

  const analysisBlock = (docs) =>
    ANALYSES.filter((a) => docs[a.key])
      .map((a) => `### ${a.title}\n${docs[a.key].trim()}`)
      .join('\n\n');

  function interpret(dream, docs) {
    return [
      { role: 'system', content: INTERP_SYSTEM },
      {
        role: 'user',
        content: `${dreamBlock(dream)}

An analysis of the dreamer's own associations:

${analysisBlock(docs)}

Using this analysis, write a dream interpretation.

${INTERP_FORMAT}`,
      },
    ];
  }

  /* ---------------- 6. Chat about the interpretation ---------------- */

  /**
   * System prompt for the interpretation chat. Context the model sees:
   * <most recent interpretation><summary of compacted conversation> + the messages since.
   */
  function chatSystem(dream, interpretation, summary) {
    return `You are Dream Guide, a warm and perceptive dream-work companion, talking with someone about an interpretation of their dream. They know their life best: engage genuinely with their questions, challenges and new information, and update your view when they give good reason. Keep replies conversational, usually under 150 words.

${dreamBlock(dream)}

The most recent interpretation:
"""
${clip(interpretation, 6000)}
"""${
      summary
        ? `

Summary of your conversation with them so far:
"""
${summary}
"""`
        : ''
    }`;
  }

  const transcriptText = (messages) =>
    messages.map((m) => `${m.role === 'user' ? 'Dreamer' : 'Guide'}: ${m.content}`).join('\n\n');

  /** Compaction: summarise the conversation (plus any previous summary) into a single summary. */
  function compactChat(previousSummary, messages) {
    return [
      { role: 'system', content: 'You summarise conversations faithfully and concisely.' },
      {
        role: 'user',
        content: `Summarise this conversation between a dreamer and a dream guide about an interpretation of the dreamer's dream. Capture what the dreamer agreed or disagreed with, any new information or context they shared about their life, questions still open, and any conclusions reached. Use concise bullet points. Output only the summary.
${previousSummary ? `\nEarlier summary:\n"""\n${previousSummary}\n"""\n` : ''}
Conversation:
"""
${clip(transcriptText(messages), 9000)}
"""`,
      },
    ];
  }

  function rewriteInterpretation(dream, docs, interpretation, summary, recent) {
    return [
      { role: 'system', content: INTERP_SYSTEM },
      {
        role: 'user',
        content: `${dreamBlock(dream)}

An analysis of the dreamer's own associations:

${analysisBlock(docs) || '(not available)'}

The current interpretation:
"""
${clip(interpretation, 6000)}
"""

Feedback from discussing it with the dreamer:
${summary ? `Summary:\n"""\n${summary}\n"""\n` : ''}${recent.length ? `Recent messages:\n"""\n${clip(transcriptText(recent), 5000)}\n"""` : ''}

Rewrite the interpretation so it fully incorporates the dreamer's feedback and anything new they shared. Output only the new interpretation.

${INTERP_FORMAT}`,
      },
    ];
  }

  /* ---------------- Categories: sort unassigned words (fresh thread, JSON) ---------------- */

  const GROUP_HINTS = {
    characters: 'people, animals, creatures and beings',
    locations: 'places, buildings, rooms and landscapes',
    objects: 'physical things and items',
    actions: 'things done or happening (verbs, events)',
    themes: 'abstract ideas, situations and concepts',
    emotions: 'feelings and moods',
  };

  function sortWordsSchema(groups) {
    return {
      type: 'object',
      properties: {
        assignments: {
          type: 'array',
          items: {
            type: 'object',
            properties: { word: { type: 'string' }, group: { type: 'string', enum: [...groups, 'ignore'] } },
            required: ['word', 'group'],
          },
        },
      },
      required: ['assignments'],
    };
  }

  function sortWords(words, groups) {
    const list = groups.map((g) => `- ${g}${GROUP_HINTS[g.toLowerCase()] ? `: ${GROUP_HINTS[g.toLowerCase()]}` : ''}`).join('\n');
    return [
      { role: 'system', content: 'You sort words from a dream journal into categories. You output JSON only.' },
      {
        role: 'user',
        content: `Categories:
${list}

For each word below, choose the single best category from the list above. Use "ignore" for words that are too generic or vague to be worth tracking across dreams (e.g. "really", "place", "started").

Words:
${words.map((w) => `- ${w}`).join('\n')}

Return JSON: {"assignments":[{"word":"...","group":"..."}]} with one entry per word, using the category names exactly as written.`,
      },
    ];
  }

  window.Prompts = {
    sortWords,
    sortWordsSchema,
    DETAIL_SCHEMA,
    ANALYSES,
    listDetails,
    listNewLeads,
    strictify,
    askAboutDetail,
    structureAnswer,
    analysis,
    interpret,
    chatSystem,
    compactChat,
    rewriteInterpretation,
  };
})();
