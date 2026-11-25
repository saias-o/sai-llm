'use strict';

// Minimal OpenAI Chat Completions client for evaluations and benchmarks.

async function chat(target, body, { timeoutMs = 10 * 60 * 1000 } = {}) {
  const started = Date.now();
  const res = await fetch(`${target.endpoint}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${target.apiKey || 'saias-local'}` },
    body: JSON.stringify({ model: target.model, stream: false, ...body }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`); }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${json.error?.message || text.slice(0, 200)}`);
  const choice = json.choices?.[0] || {};
  return {
    message: choice.message || { role: 'assistant', content: '' },
    finishReason: choice.finish_reason,
    usage: json.usage || {},
    timings: json.timings || null, // llama-server: prompt_per_second, predicted_per_second, ...
    ms: Date.now() - started,
  };
}

// Text of an assistant message without the reasoning part.
function contentOf(message) {
  const c = message?.content;
  if (Array.isArray(c)) return c.map(p => p.text || '').join('');
  return String(c || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

function toolCallsOf(message) {
  return (message?.tool_calls || []).map(call => {
    let args = null;
    try { args = JSON.parse(call.function?.arguments || '{}'); } catch { /* invalid JSON arguments */ }
    return { id: call.id, name: call.function?.name, raw: call.function?.arguments, args };
  });
}

module.exports = { chat, contentOf, toolCallsOf };
