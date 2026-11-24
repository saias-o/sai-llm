/* ================= SAI-LLM web — app.js ================= */
/* Drop-in frontend for the plain Node `http` proxy in server.js.
 * SSE parsing, conversation CRUD, reasoning levels and per-model
 * support rules mirror the native client (chat.cpp / chat.hpp) and
 * README (2026-11-24). Served from the same origin as /api/*. */

const BASE = '';

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
function el(id) { return document.getElementById(id); }
function toast(msg, type) {
  const t = el('toast');
  t.textContent = msg;
  t.className = 'toast show ' + (type || '');
  setTimeout(() => t.classList.remove('show'), 3400);
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function shortDate(iso) { return iso ? iso.slice(0, 10).replace(/T/g, ' ') : ''; }

/* ---------- native-parity constants ----------
 * levels (chat.cpp L30-38): [key, label, value]
 *   key is what is sent in the `reasoning` body field. */
const LEVELS = [
  { key: 'default',  label: 'Model default', value: 0.00 },
  { key: 'none',     label: 'Off',           value: 0.00 },
  { key: 'on',       label: 'On',            value: 0.00 },
  { key: 'low',      label: 'Low',           value: 0.20 },
  { key: 'medium',   label: 'Medium',        value: 0.70 },
  { key: 'high',     label: 'High',          value: 0.90 },
  { key: 'xhigh',    label: 'Extra high',    value: 0.99 },
];
const ARCHIVE_LIMIT = 32 * 1024 * 1024;   // native archive_limit
function supportsReasoning(modelId, levelKey) {
  if (!LEVELS.some(level => level.key === levelKey)) return false;
  if (levelKey === 'default' || levelKey === 'none') return true;
  if (modelId === 'sai-smart') return levelKey === 'medium' || levelKey === 'xhigh';
  return modelId === 'sai-flash' ? levelKey === 'on' : levelKey !== 'on';
}
function supportsImages(modelId) { return modelId === 'sai-smart' || modelId === 'sai-max'; }

// ---------- state ----------
let models = {};
let convs = [];
let activeConv = null;
let currentMsgs = [];
let attachments = [];
let theme = 'dark';
let settings = { memory: '', system: '' };
let busy = false;

// ---------- render: list + selects ----------
function renderConvs() {
  const ul = el('conv-list');
  ul.innerHTML = '';
  const frag = document.createDocumentFragment();
  convs.forEach((c) => {
    const li = document.createElement('li');
    li.className = 'conv-item' + (c.id === activeConv?.id ? ' active' : '');
    const title = (c.preview || c.id).trim().replace(/\s+/g, ' ') || c.id;
    li.innerHTML =
      '<div class="conv-title" title="' + esc(title) + '">' + esc(title) + '</div>' +
      '<div class="conv-meta">' +
        '<span class="conv-model">' + esc(c.model || '?') + '</span> ' +
        '<span>' + (c.turnCount || 0) + ' turns</span> ' +
        '<span>' + esc(shortDate(c.createdAt)) + '</span>' +
      '</div>';
    li.addEventListener('click', () => openConv(c.id));
    frag.appendChild(li);
  });
  ul.appendChild(frag);
}
function renderModelSelect() {
  const sel = el('model-select');
  const names = Object.keys(models);
  sel.innerHTML = names.map((m) => {
    const o = models[m] || {};
    const label = m === 'sai-smart' ? 'sai-smart (Bonsai 2 27B)' : m;
    return '<option value="' + esc(m) + '">' + esc(label) + (o.online ? '' : ' (offline)') + '</option>';
  }).join('');
  if (activeConv && activeConv.model in models) sel.value = activeConv.model;
  syncReasoningSelect();
}
function syncReasoningSelect() {
  const m = el('model-select').value || 'sai-smart';
  const sel = el('reasoning-select');
  sel.querySelectorAll('option').forEach((o) => o.disabled = !supportsReasoning(m, o.value));
  const saved = activeConv?.reasoning === 'off' ? 'none' : activeConv?.reasoning;
  sel.value = supportsReasoning(m, saved) ? saved : 'default';
  el('image-btn').classList.toggle('disabled', !supportsImages(m));
}
function updateStatusDot() {
  const dot = el('status-dot'), txt = el('status-text');
  const name = el('model-select').value;
  const model = models[name];
  dot.style.background = !model ? 'var(--muted)' : (model.online ? 'var(--ok)' : 'var(--warn)');
  txt.textContent = !model ? '' : (model.online ? 'backend online' : 'backend offline');
}

function loadModels() {
  return fetch(BASE + '/api/models')
    .then((r) => r.json())
    .then((d) => {
      models = d.models || {};
      renderModelSelect();
      updateStatusDot();
    })
    .catch((e) => {});
}

// ---------- settings ----------
async function loadSettings() {
  try {
    const r = await fetch(BASE + '/api/settings');
    if (!r.ok) return;
    const s = await r.json();
    if (s) { settings.memory = s.memory || ''; settings.system = s.system_prompt || ''; }
  } catch (e) {}
}
async function saveSettings() {
  settings.memory = el('memory-input').value;
  settings.system = el('system-input').value;
  try {
    const r = await fetch(BASE + '/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memory: settings.memory, system_prompt: settings.system }),
    });
    if (!r.ok) throw new Error('Failed to save settings');
    toast('Settings saved', 'ok');
    closeModal('settings');
  } catch (e) { toast('Failed to save settings: ' + e.message, 'err'); return; }
}

// ---------- hardware + advisor ----------
async function loadHardware() {
  const box = el('hardware-body');
  try {
    const d = await fetch(BASE + '/api/material');
    if (!d.ok) { box.textContent = 'not available'; return; }
    const hw = await d.json();
    let html = '';
    if (hw.cpu?.cores) html += '<div class="hw"><b>CPU:</b> ' + hw.cpu.cores + ' cores</div>';
    if (hw.ram?.totalGB) html += '<div class="hw"><b>RAM:</b> ' + hw.ram.totalGB + ' GB</div>';
    if (hw.os && hw.os.platform) html += '<div class="hw"><b>OS:</b> ' + esc(hw.os.platform) + '</div>';
    if (hw.gpu && hw.gpu.present) html += '<div class="hw"><b>GPU:</b> ' + esc(hw.gpu.name || 'none') + (hw.gpu.vramGB ? ' (' + hw.gpu.vramGB + ' GB VRAM)' : '') + '</div>';
    box.innerHTML = html || 'hardware not available';
  } catch (e) { box.textContent = 'not available'; }
}
async function loadAdvisor() {
  const card = el('advisor-box'), body = el('advisor-body');
  try {
    const d = await fetch(BASE + '/api/advisor');
    const rec = d.ok ? await d.json() : null;
    card.hidden = !rec;
    if (rec) {
      body.innerHTML =
        '<div class="adv"><b>Capable:</b> ' + esc(rec.capable || 'n/a') + '</div>' +
        '<div class="adv"><b>Everyday:</b> ' + esc(rec.everyday || 'n/a') + '</div>' +
        (rec.reason ? '<div class="adv reason">' + esc(rec.reason) + '</div>' : '');
    }
  } catch (e) { card.hidden = true; }
}

// ---------- templates ----------
async function loadTemplates() {
  const list = el('templates-list');
  try {
    const response = await fetch(BASE + '/api/templates');
    const d = await response.json();
    const names = (d && Array.isArray(d.templates)) ? d.templates : [];
    list.hidden = false;
    el('template-view').hidden = true;
    list.innerHTML = '';
    if (!names.length) { list.innerHTML = '<li class="empty">No templates</li>'; return; }
    names.forEach((name) => {
      const li = document.createElement('li');
      li.className = 'template-item';
      li.textContent = name;
      li.addEventListener('click', () => openTemplate(name));
      list.appendChild(li);
    });
  } catch (e) { list.innerHTML = '<li class="empty">could not load</li>'; }
}
async function openTemplate(name) {
  try {
    const r = await fetch(BASE + '/api/templates/' + encodeURIComponent(name));
    if (!r.ok) { toast('Template not found', 'err'); return; }
    el('template-name').textContent = name;
    el('template-text').textContent = await r.text();
    el('templates-list').hidden = true;
    el('template-view').hidden = false;
  } catch (e) { toast('Could not load template', 'err'); }
}

// ---------- modals ----------
function openModal(name) {
  const map = { settings: 'settings-modal', templates: 'templates-modal' };
  const m = el(map[name]);
  if (m) m.hidden = false;
}
function closeModal(name) {
  const map = { settings: 'settings-modal', templates: 'templates-modal' };
  const m = el(map[name]);
  if (m) m.hidden = true;
}
function openSettings() {
  el('memory-input').value = settings.memory || '';
  el('system-input').value = settings.system || '';
  openModal('settings');
}

// ---------- PDF + attachments (native append_user_message L233-270) ----------
async function extractPdfText(file) {
  const buf = await file.arrayBuffer();
  const { getDocument, GlobalWorkerOptions } = window.pdfjsLib;
  GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  const doc = await getDocument({ data: buf, isEvalSupported: false }).promise;
  let text = '';
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    text += content.items.map((i) => i.str).join('\n') + '\n\n';
    if (page.dispose) await page.dispose();
  }
  await doc.destroy();
  return text.trim();
}
function pickFile(input) {
  input.value = '';
  return new Promise((res) => {
    input.onchange = (e) => res(e.target.files[0] || null);
    input.oncancel = () => res(null);
    input.click();
  });
}
async function addPdf() {
  const f = await pickFile(el('pdf-input'));
  if (!f) return;
  if (f.size > ARCHIVE_LIMIT) { toast('The PDF is too large.', 'err'); return; }
  try {
    const text = await extractPdfText(f);
    attachments.push({ name: f.name, text: text || f.name });
    renderChips();
  } catch (e) { toast('Could not read PDF: ' + (e.message || e), 'err'); }
}
async function addImage() {
  const m = el('model-select').value || 'sai-smart';
  if (!supportsImages(m)) { toast('Images require sai-smart or sai-max', 'err'); return; }
  const f = await pickFile(el('image-input'));
  if (!f) return;
  if (f.size > 5 * 1024 * 1024) { toast('The image is too large.', 'err'); return; }
  if (!['image/png', 'image/jpeg'].includes(f.type)) { toast('Choose a PNG or JPEG image.', 'err'); return; }
  try {
    attachments.push({ name: f.name, image_url: await dataUrl(f) });
    renderChips();
  } catch { toast('Could not read the image.', 'err'); }
}
function dataUrl(file) {
  return new Promise((res, reject) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}
function renderChips() {
  const c = el('attachments');
  c.innerHTML = '';
  attachments.forEach((a, i) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = '<span>' + esc(a.name) + '</span><button title="Remove" onclick="removeChip(' + i + ')">×</button>';
    c.appendChild(chip);
  });
  el('pdf-btn').classList.toggle('hidden', attachments.length >= 5);
  el('image-btn').classList.toggle('hidden', attachments.length >= 5);
}
window.removeChip = (i) => { attachments.splice(i, 1); renderChips(); };

// ---------- message rendering ----------
function fmt(t) {
  let s = esc(t);
  s = s.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/^&gt; ?(.*)$/gm, '<blockquote>$1</blockquote>');
  s = s.replace(/^[-*]\s(.*?)(?=\n|$)/gm, '<li>$1</li>');
  return s.split(/\n\n+/).map((p) => '<p>' + p + '</p>').join('');
}
function renderMsg(role, content, thinking) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  const who = role === 'user' ? 'You' : 'Assistant';
  div.innerHTML = '<div class="who">' + who + '</div>' +
    (role === 'assistant'
      ? '<div class="think' + (thinking ? ' open"' : '" hidden') + '><div class="think-head">Reasoning <span>▶</span></div><div class="think-body">' + esc(thinking || '') + '</div></div>'
      : '') +
    '<div class="msg-body"></div>';
  div.querySelector('.msg-body').innerHTML = fmt(content || '');
  return div;
}
function appendMsg(role, content, thinking) {
  const asst = renderMsg(role, content, thinking);
  el('chat').appendChild(asst);
  asst.classList.add('enter');
  el('chat').scrollTop = el('chat').scrollHeight;
  return asst;
}
function renderMessages() {
  el('chat').replaceChildren(el('empty'));
  el('empty').hidden = currentMsgs.length > 0;
  currentMsgs.forEach((m) => appendMsg(m.role, displayContent(m), m.thinking));
  el('chat').scrollTop = el('chat').scrollHeight;
}
function focusPrompt() { el('prompt').focus(); }
function displayContent(message) {
  return [message.content, ...(message.attachments || []).map(a => '📎 ' + a.name)].filter(Boolean).join('\n\n');
}

// ---------- conversation flows ----------
function newConv() {
  if (busy) return;
  const m = el('model-select').value || 'sai-smart';
  activeConv = { id: null, model: m, reasoning: 'default' };
  currentMsgs = [];
  resetComposer();
  syncReasoningSelect();
  renderConvs();
  renderMessages();
  focusPrompt();
}
async function loadConversations() {
  const response = await fetch(BASE + '/api/conversations');
  if (!response.ok) throw new Error('Could not load conversations');
  convs = await response.json();
  renderConvs();
}
async function openConv(id) {
  if (busy) return;
  try {
    const r = await fetch(BASE + '/api/conversations/' + encodeURIComponent(id));
    if (!r.ok) { toast('Could not open conversation'); return; }
    const c = await r.json();
    if (busy) return;
    activeConv = { id: c.id, model: c.model, reasoning: c.reasoning };
    currentMsgs = c.messages || [];
    if (c.model in models) el('model-select').value = c.model;
    resetComposer();
    syncReasoningSelect();
    updateStatusDot();
    renderConvs();
    renderMessages();
    focusPrompt();
  } catch (e) { toast('Could not open conversation'); }
}
async function saveConversation() {
  if (!activeConv.id) {
    const create = await fetch(BASE + '/api/conversations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(activeConv),
    });
    if (!create.ok) throw new Error('Could not create conversation');
    activeConv.id = (await create.json()).id;
  }
  const response = await fetch(BASE + '/api/conversations/' + encodeURIComponent(activeConv.id), {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...activeConv, messages: currentMsgs }),
  });
  if (!response.ok) throw new Error('Could not save conversation');
  await loadConversations();
}
function resetComposer() {
  attachments = [];
  renderChips();
  el('prompt').value = '';
}

/* ---------- faithful SSE send (native chat.cpp L600-690) ----------
 * The proxy forwards llama-server's OpenAI-compatible stream verbatim.
 * We separate delta.reasoning_content / delta.reasoning (thinking) from
 * delta.content (answer); thinking is accumulated only while !have_answer;
 * we stop on finish_reason and the [DONE] sentinel; an oversized answer
 * aborts with the native "too large" error. */
async function send() {
  const text = el('prompt').value.trim();
  if ((!text && !attachments.length) || busy) return;

  const m = el('model-select').value || 'sai-smart';
  const reasoning = el('reasoning-select').value || 'default';
  if (!supportsImages(m) && attachments.some(a => a.image_url)) {
    toast('Remove the image or select sai-smart or sai-max.', 'err');
    return;
  }
  activeConv.model = m;
  activeConv.reasoning = reasoning;

  const userMsg = { role: 'user', content: text, attachments: [...attachments] };
  const system = [settings.system, settings.memory && 'User-provided memory:\n' + settings.memory].filter(Boolean).join('\n\n');
  const messages = [...currentMsgs, userMsg];
  if (system) messages.unshift({ role: 'system', content: system });

  renderMessages();
  appendMsg('user', displayContent(userMsg));
  const asst = appendMsg('assistant', '', '');
  const thinkHead = asst.querySelector('.think-head');
  const asstBody = asst.querySelector('.msg-body');
  asstBody.innerHTML = '<span class="thinking">…</span>';
  el('empty').hidden = true;

  const state = { answer: '', thinking: '', have_answer: false, finished_choice: false, done: false, error: '' };

  busy = true;
  el('send').disabled = true;
  el('prompt').readOnly = true;
  el('model-select').disabled = true;
  el('reasoning-select').disabled = true;
  el('new-chat').disabled = true;
  el('pdf-btn').disabled = true;
  el('image-btn').disabled = true;

  try {
    const r = await fetch(BASE + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: m, reasoning, messages }),
    });
    if (r.status === 503) {
      const b = await r.json().catch(() => ({}));
      throw new Error('Backend is offline (port ' + (b.port || '?') + ')');
    }
    if (!r.ok) {
      const b = await r.json().catch(() => ({}));
      throw new Error(b.error?.message || b.error || 'Request failed: ' + r.status);
    }
    if (!r.headers.get('content-type')?.includes('text/event-stream')) {
      throw new Error('The local server did not return an event stream.');
    }

    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let pending = '';
    try {
      while (!state.done && !state.error) {
        const { done, value } = await reader.read();
        pending += dec.decode(value, { stream: !done });
        if (pending.length > ARCHIVE_LIMIT) throw new Error('The local server sent an invalid event stream.');
        processSSE(done ? pending + '\n' : pending, state, asst);
        pending = pending.slice(pending.lastIndexOf('\n') + 1);
        if (done) break;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (state.error) throw new Error(state.error);
    if (!state.done && !state.finished_choice) throw new Error('The model response ended early.');
    if (!state.answer.trim()) throw new Error('The model returned no final answer.');

    currentMsgs.push(userMsg, { role: 'assistant', content: state.answer, thinking: state.thinking });
    resetComposer();
    try { await saveConversation(); }
    catch (e) { toast(e.message, 'err'); }
  } catch (e) {
    thinkHead.classList.add('error');
    asstBody.innerHTML = '<span class="err">' + esc(e.message) + '</span>';
    toast('Send failed: ' + e.message, 'err');
  } finally {
    busy = false;
    el('send').disabled = false;
    el('prompt').readOnly = false;
    el('model-select').disabled = false;
    el('reasoning-select').disabled = false;
    el('new-chat').disabled = false;
    el('pdf-btn').disabled = false;
    el('image-btn').disabled = false;
    focusPrompt();
  }
}
function renderAsstBody(asst, state) {
  asst.querySelector('.msg-body').innerHTML = fmt(state.answer);
  el('chat').scrollTop = el('chat').scrollHeight;
}
function showThinking(asst, state) {
  const th = asst.querySelector('.think');
  if (!th) return;
  const body = th.querySelector('.think-body');
  body.textContent = state.thinking;
  th.hidden = false;
  th.classList.add('open');
}
function closeThinking(asst, state) {
  const th = asst.querySelector('.think');
  if (!th) return;
  const head = th.querySelector('.think-head');
  const body = th.querySelector('.think-body');
  const has = (body ? body.textContent : '').trim().length > 0;
  head.classList.add('closed', has ? 'has-content' : 'empty');
}
function consume(payload, state, asst) {
  let json;
  try { json = JSON.parse(payload); } catch { return; }
  if (json.error) { state.error = json.error.message || String(json.error); return; }
  const choices = json.choices;
  if (!Array.isArray(choices) || choices.length === 0) return;
  const choice = choices[0];
  const delta = choice.delta;
  const text = (delta && typeof delta.content === 'string') ? delta.content : '';
  const thinking = (delta && (delta.reasoning_content || delta.reasoning)) || '';

  if (text.length) {
    state.answer += text;
    if (state.answer.length > ARCHIVE_LIMIT) { state.error = 'The local server sent a response that was too large.'; return; }
    state.have_answer = true;
    closeThinking(asst, state);
  } else if (thinking.length && !state.have_answer) {
    state.thinking += thinking;
    showThinking(asst, state);
  }
  if (choice && choice.finish_reason) state.finished_choice = true;
  renderAsstBody(asst, state);
}
function processSSE(pending, state, asst) {
  if (state.done || state.error) return;
  const lines = pending.split('\n');
  const complete = lines.slice(0, -1);
  for (const raw of complete) {
    let line = raw;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.startsWith('data:')) {
      line = line.slice(5);
      if (line.startsWith(' ')) line = line.slice(1);
      if (line === '[DONE]') { state.done = true; return; }
      consume(line, state, asst);
    }
  }
}

// ---------- theme ----------
function setTheme(t) {
  theme = t;
  document.body.className = t === 'light' ? 'light' : '';
  try { localStorage.setItem('sai-theme', t); } catch (e) {}
}
function initTheme() {
  let t = null;
  try { t = localStorage.getItem('sai-theme'); } catch (e) {}
  setTheme(t === 'light' || t === 'dark' ? t : 'dark');
}

// ---------- init ----------
function initReasoningSelect() {
  const sel = el('reasoning-select');
  sel.innerHTML = LEVELS.map((l) => '<option value="' + l.key + '">' + esc(l.label) + '</option>').join('');
}
function bindButtons() {
  el('send').addEventListener('click', send);
  el('new-chat').addEventListener('click', newConv);
  el('theme-btn').addEventListener('click', () => setTheme(theme === 'light' ? 'dark' : 'light'));
  el('templates-btn').addEventListener('click', () => { loadTemplates(); openModal('templates'); });
  el('settings-btn').addEventListener('click', openSettings);
  el('save-settings').addEventListener('click', saveSettings);
  el('cancel-settings').addEventListener('click', () => closeModal('settings'));
  el('cancel-templates').addEventListener('click', () => closeModal('templates'));
  el('close-settings').addEventListener('click', () => closeModal('settings'));
  el('close-templates').addEventListener('click', () => closeModal('templates'));
  el('copy-template').addEventListener('click', () => {
    const t = el('template-text').textContent;
    navigator.clipboard.writeText(t).then(() => toast('Template copied'), () => {});
  });
  el('pdf-btn').addEventListener('click', addPdf);
  el('image-btn').addEventListener('click', addImage);
  el('model-select').addEventListener('change', () => {
    activeConv.model = el('model-select').value;
    syncReasoningSelect();
    updateStatusDot();
  });
  el('reasoning-select').addEventListener('change', () => {
    activeConv.reasoning = el('reasoning-select').value;
  });
  el('prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  el('chat').addEventListener('click', (e) => {
    const head = e.target.closest('.think-head');
    if (!head) return;
    const th = head.closest('.think');
    if (th.querySelector('.think-body').textContent) th.classList.toggle('open');
  });
}

window.addEventListener('DOMContentLoaded', () => {
  initReasoningSelect();
  initTheme();
  bindButtons();
  newConv();
  loadModels();
  loadSettings();
  loadHardware();
  loadAdvisor();
  loadConversations().catch(e => toast(e.message, 'err'));
});
