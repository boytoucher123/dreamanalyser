'use strict';
/** Minimal Ollama HTTP client (https://github.com/ollama/ollama/blob/main/docs/api.md). */

function normaliseHost(host) {
  let h = String(host || 'http://127.0.0.1:11434').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(h)) h = `http://${h}`;
  return h;
}

async function listModels(host) {
  const res = await fetch(`${normaliseHost(host)}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Ollama responded with ${res.status}`);
  const json = await res.json();
  return (json.models || [])
    .map((m) => ({ name: m.name, size: m.size, family: m.details?.family, parameters: m.details?.parameter_size }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Stream a chat completion. Calls onToken(text) for each content chunk and
 * resolves with { content, aborted } once the response is complete.
 */
async function chat(host, request, onToken, signal) {
  let content = '';
  let res;
  try {
    res = await fetch(`${normaliseHost(host)}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...request, stream: true }),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') return { content, aborted: true };
    throw new Error(`Could not reach Ollama at ${normaliseHost(host)} — is it running? (${err.cause?.code || err.message})`);
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json()).error || '';
    } catch {
      /* ignore */
    }
    throw new Error(`Ollama error ${res.status}${detail ? `: ${detail}` : ''}`);
  }

  const decoder = new TextDecoder();
  let buffer = '';
  const handleLine = (line) => {
    if (!line.trim()) return;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    if (obj.error) throw new Error(`Ollama error: ${obj.error}`);
    const piece = obj.message?.content || '';
    if (piece) {
      content += piece;
      onToken(piece);
    }
  };

  try {
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        handleLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    }
    handleLine(buffer);
  } catch (err) {
    if (err.name === 'AbortError' || signal?.aborted) return { content, aborted: true };
    throw err;
  }
  return { content, aborted: false };
}

module.exports = { listModels, chat, normaliseHost };
