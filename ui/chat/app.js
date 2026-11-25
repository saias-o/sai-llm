// SAIAS Chat. Talks to the SAIAS hub it is served from: /v1/models, /tools, /v1/chat/completions,
// and /saias/chat/api for conversations and settings (the same files as the native chat).
'use strict';

const MAX_TOOL_ROUNDS = 8;
const TOOL_RESULT_LIMIT = 24000;
const API = '/saias/chat/api';
const LEVEL_LABELS = { none: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high' };
const TOOL_LABELS = { web_search: 'Web search', web_fetch: 'Read web pages', web_research: 'Web research' };
const TOOL_HINTS = {
  web_search: 'Find pages, news and facts',
  web_fetch: 'Open a link and read it',
  web_research: 'Search and read the best pages in one step',
};
const SUGGESTIONS = [
  ['Search the web', 'for the latest news about local AI models'],
  ['Explain', 'how a transformer model works, simply'],
  ['Write code', 'a Python script that renames photos by date'],
  ['Help me write', 'a polite email to reschedule a meeting'],
];

const $ = id => document.getElementById(id);
const md = window.SaiasMarkdown;
const icons = {
  copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
  retry: '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
  chevron: '<svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg>',
  page: '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>',
  globe: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  warn: '<svg viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
};

const state = {
  models: [],
  tools: [],
  settings: { memory: '', system_prompt: '', tools: ['web_search', 'web_fetch', 'web_research'] },
  list: [],
  current: null,      // { id, data: { model, reasoning, context_tokens, messages }, saved }
  busy: null,         // { controller, reply, base, chars }
  attachments: [],    // pending: { name, text?, image_url?, size, kind }
  speed: null,        // { value, id }
  lastModel: localStorage.getItem('saias.model') || 'saias-flash',
};

// ---------------------------------------------------------------- helpers

function newId() {
  const uuid = crypto.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => ((Math.random() * 16) | (c === 'x' ? 0 : 8)).toString(16));
  return `{${uuid.toUpperCase()}}`;
}

async function api(path, options = {}) {
  const res = await fetch(path, options);
  const type = res.headers.get('content-type') || '';
  const body = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(body?.error?.message || body?.error || `HTTP ${res.status}`);
  return body;
}

function compact(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k';
  return String(n);
}
const thousands = n => Number(n || 0).toLocaleString('en-US');

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

function toast(text) {
  const t = el('div', 'toast');
  t.textContent = text;
  document.body.append(t);
  setTimeout(() => t.remove(), 1600);
}

function setStatus(text, error = false) {
  const s = $('status');
  s.textContent = text || '';
  s.classList.toggle('error', Boolean(error));
}

// The conversation file without the view's private fields (names starting with "_").
function serialize(data) {
  return JSON.stringify(data, (key, value) => (key.startsWith('_') ? undefined : value));
}

function modelInfo(id) {
  return state.models.find(m => m.id === id) || null;
}

function toolLabel(name) {
  return TOOL_LABELS[name] || name;
}

// ---------------------------------------------------------------- loading

async function loadModels() {
  const res = await api('/v1/models');
  state.models = (res.data || []).filter(m => m.id && m.id.startsWith('saias-'));
}

async function loadTools() {
  try {
    const list = await api('/tools');
    state.tools = Array.isArray(list) ? list.filter(t => t.definition?.function?.name) : [];
  } catch {
    state.tools = [];
  }
}

async function loadSettings() {
  try {
    const s = await api(`${API}/settings`);
    state.settings = {
      memory: s.memory || '',
      system_prompt: s.system_prompt || '',
      tools: Array.isArray(s.tools) ? s.tools : state.settings.tools,
    };
  } catch { /* defaults */ }
}

async function loadList() {
  try { state.list = await api(`${API}/conversations`); } catch { state.list = []; }
  renderHistory();
}

function blankConversation() {
  const model = modelInfo(state.lastModel) ? state.lastModel : (state.models[0]?.id || 'saias-flash');
  return { id: newId(), data: { model, reasoning: 'default', context_tokens: 0, messages: [] }, saved: false };
}

async function openConversation(id) {
  if (state.busy) return;
  try {
    const data = await api(`${API}/conversations/${encodeURIComponent(id)}`);
    data.messages = Array.isArray(data.messages) ? data.messages : [];
    data.reasoning ||= 'default';
    if (!modelInfo(data.model) && state.models.length) data.model = state.models[0].id;
    state.current = { id, data, saved: true };
    state.attachments = [];
    renderAll();
    scrollToBottom(true);
  } catch (e) {
    setStatus(`Could not open this conversation: ${e.message}`, true);
  }
}

function newConversation() {
  if (state.busy) return;
  state.current = blankConversation();
  state.attachments = [];
  renderAll();
  $('input').focus();
}

async function save() {
  const c = state.current;
  if (!c || !c.data.messages.length) return;
  try {
    await api(`${API}/conversations/${encodeURIComponent(c.id)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: serialize(c.data),
    });
    c.saved = true;
    const title = conversationTitle(c.data);
    const entry = state.list.find(x => x.id === c.id);
    if (entry) { entry.title = title; entry.updated = Date.now(); entry.model = c.data.model; }
    else state.list.unshift({ id: c.id, title, model: c.data.model, updated: Date.now() });
    state.list.sort((a, b) => b.updated - a.updated);
    renderHistory();
  } catch (e) {
    setStatus(`The conversation could not be saved: ${e.message}`, true);
  }
}

async function deleteConversation(id) {
  const entry = state.list.find(x => x.id === id);
  if (!confirm(`Delete "${entry?.title || 'this conversation'}"? This cannot be undone.`)) return;
  try {
    await api(`${API}/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
    state.list = state.list.filter(x => x.id !== id);
    if (state.current?.id === id) newConversation();
    else renderHistory();
  } catch (e) {
    setStatus(`Could not delete: ${e.message}`, true);
  }
}

function conversationTitle(data) {
  const first = data.messages.find(m => m.role === 'user');
  const text = (first?.content || first?.attachments?.[0]?.name || 'New conversation').split(/\r?\n/)[0].trim();
  return text.length > 60 ? text.slice(0, 60) + '…' : text;
}

// ---------------------------------------------------------------- sidebar

function renderHistory() {
  const box = $('history');
  const filter = $('search').value.trim().toLowerCase();
  box.innerHTML = '';
  const items = state.list.filter(x => !filter || x.title.toLowerCase().includes(filter));
  if (!items.length) {
    box.append(el('div', 'history-empty', filter ? 'No chat matches this search.' : 'Your chats will appear here.'));
    return;
  }
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const group = t => (t >= startOfDay ? 'Today' : t >= startOfDay - 86400000 ? 'Yesterday'
    : t >= startOfDay - 7 * 86400000 ? 'Previous 7 days' : t >= startOfDay - 30 * 86400000 ? 'Previous 30 days' : 'Older');
  let last = '';
  for (const item of items) {
    const g = group(item.updated);
    if (g !== last) { box.append(el('div', 'history-group', g)); last = g; }
    const row = el('button', 'history-item' + (state.current?.id === item.id ? ' active' : ''));
    row.type = 'button';
    row.title = item.title;
    const title = el('span', 'history-title');
    title.textContent = item.title;
    const del = el('span', 'history-delete', icons.trash);
    del.title = 'Delete';
    del.addEventListener('click', e => { e.stopPropagation(); deleteConversation(item.id); });
    row.append(title, del);
    row.addEventListener('click', () => openConversation(item.id));
    box.append(row);
  }
}

// ---------------------------------------------------------------- top bar

function closeMenus(except) {
  for (const id of ['model-menu', 'reasoning-menu', 'tools-menu']) if (id !== except) $(id).hidden = true;
}

function toggleMenu(id, fill) {
  const menu = $(id);
  const open = menu.hidden;
  closeMenus(id);
  if (open) { fill(menu); menu.hidden = false; } else menu.hidden = true;
}

function renderModelMenu(menu) {
  menu.innerHTML = '';
  menu.append(el('div', 'menu-label', 'Model'));
  for (const m of state.models) {
    const item = el('button', 'menu-item');
    item.type = 'button';
    const info = m.saias || {};
    const sub = [info.model, m.context_length ? `${compact(m.context_length)} context` : '', info.vision ? 'images' : '',
      m.status?.value === 'loaded' ? 'loaded' : ''].filter(Boolean).join(' · ');
    item.innerHTML = `<span class="check">${m.id === state.current.data.model ? icons.check : ''}</span>
      <span><span class="title"></span><span class="sub"></span></span>`;
    item.querySelector('.title').textContent = m.id;
    item.querySelector('.sub').textContent = sub;
    item.addEventListener('click', () => {
      state.current.data.model = m.id;
      state.lastModel = m.id;
      localStorage.setItem('saias.model', m.id);
      const levels = reasoningLevels(m);
      if (state.current.data.reasoning !== 'default' && !levels.includes(state.current.data.reasoning)) state.current.data.reasoning = 'default';
      closeMenus();
      renderTopbar();
      renderAttachments();
      if (state.current.saved) save();
    });
    menu.append(item);
  }
  if (!state.models.length) menu.append(el('div', 'menu-label', 'No model installed. Run Install-SAIAS.cmd.'));
}

function reasoningLevels(model) {
  return model?.saias?.reasoning?.levels || [];
}

function renderReasoningMenu(menu) {
  const model = modelInfo(state.current.data.model);
  const levels = reasoningLevels(model);
  const def = model?.saias?.reasoning?.default;
  menu.innerHTML = '';
  menu.append(el('div', 'menu-label', 'Reasoning'));
  const options = [['default', `Default${def ? ` (${LEVEL_LABELS[def] || def})` : ''}`, 'What the model is tuned for']];
  for (const level of levels) options.push([level, LEVEL_LABELS[level] || level, level === 'none' ? 'Answer directly, fastest' : 'Think longer before answering']);
  for (const [value, label, sub] of options) {
    const item = el('button', 'menu-item');
    item.type = 'button';
    item.innerHTML = `<span class="check">${state.current.data.reasoning === value ? icons.check : ''}</span><span><span class="title"></span><span class="sub"></span></span>`;
    item.querySelector('.title').textContent = label;
    item.querySelector('.sub').textContent = sub;
    item.addEventListener('click', () => {
      state.current.data.reasoning = value;
      closeMenus();
      renderTopbar();
      if (state.current.saved) save();
    });
    menu.append(item);
  }
}

function renderToolsMenu(menu) {
  menu.innerHTML = '';
  menu.append(el('div', 'menu-label', 'Web tools the model may use'));
  if (!state.tools.length) {
    menu.append(el('div', 'menu-label', 'No tools available. Restart SAIAS to load them.'));
    return;
  }
  for (const t of state.tools) {
    const name = t.definition.function.name;
    const on = state.settings.tools.includes(name);
    const item = el('button', 'menu-item' + (on ? ' on' : ''));
    item.type = 'button';
    item.innerHTML = `<span class="check">${icons[name === 'web_fetch' ? 'page' : name === 'web_search' ? 'search' : 'globe']}</span>
      <span><span class="title"></span><span class="sub"></span></span><span class="switch"></span>`;
    item.querySelector('.title').textContent = toolLabel(name);
    item.querySelector('.sub').textContent = TOOL_HINTS[name] || (t.definition.function.description || '').split('.')[0];
    item.addEventListener('click', async () => {
      const tools = new Set(state.settings.tools);
      if (tools.has(name)) tools.delete(name); else tools.add(name);
      state.settings.tools = [...tools];
      renderToolsMenu(menu);
      renderTopbar();
      await saveSettings();
    });
    menu.append(item);
  }
}

async function saveSettings() {
  try {
    await api(`${API}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state.settings) });
  } catch (e) {
    setStatus(`Settings could not be saved: ${e.message}`, true);
  }
}

function enabledTools() {
  return state.tools.filter(t => state.settings.tools.includes(t.definition.function.name));
}

function renderTopbar() {
  const data = state.current.data;
  const model = modelInfo(data.model);
  $('model-name').textContent = data.model;
  const def = model?.saias?.reasoning?.default;
  $('reasoning-name').textContent = data.reasoning === 'default'
    ? `Reasoning: ${LEVEL_LABELS[def] || 'default'}` : `Reasoning: ${LEVEL_LABELS[data.reasoning] || data.reasoning}`;
  $('reasoning-button').classList.toggle('on', data.reasoning !== 'default' && data.reasoning !== 'none');
  const count = enabledTools().length;
  $('tools-name').textContent = count ? `Web tools · ${count}` : 'Web tools off';
  $('tools-button').classList.toggle('on', count > 0);
  renderGauge();
}

// ---------------------------------------------------------------- context gauge

function estimateTokens(data) {
  let chars = 0;
  for (const m of data.messages) {
    chars += (m.content || '').length;
    for (const a of m.attachments || []) chars += (a.text || '').length;
    for (const r of m.tool_rounds || []) {
      chars += (r.text || '').length;
      for (const c of r.calls || []) chars += (c.arguments || '').length + (c.result || '').length;
    }
  }
  return Math.round(chars / 4);
}

function renderGauge() {
  const data = state.current.data;
  const model = modelInfo(data.model);
  const total = model?.context_length || 0;
  const busy = state.busy && state.busy.id === state.current.id;
  const exact = Boolean(data.context_tokens) && !busy;
  const used = busy ? state.busy.base + Math.round(state.busy.chars / 4) : (data.context_tokens || estimateTokens(data));
  const share = total ? Math.min(1, used / total) : 0;
  const gauge = $('gauge');
  gauge.classList.toggle('warn', share >= 0.75 && share < 0.9);
  gauge.classList.toggle('full', share >= 0.9);
  $('ring-fill').style.strokeDashoffset = String(94.25 * (1 - Math.max(share, used ? 0.02 : 0)));
  $('gauge-used').textContent = (exact || busy || !used ? '' : '≈') + compact(used);
  $('gauge-total').textContent = total ? ` / ${compact(total)}` : '';
  const speed = state.speed && state.speed.id === state.current.id ? state.speed.value : null;
  const percent = total ? (share * 100).toFixed(share < 0.1 ? 1 : 0) : null;
  $('gauge-tip').innerHTML = `
    <div class="row"><span>Context in use</span><b>${thousands(used)} tokens</b></div>
    ${total ? `<div class="bar"><i style="width:${Math.max(share * 100, used ? 1 : 0)}%"></i></div>
    <div class="row"><span>Context window</span><b>${thousands(total)}</b></div>
    <div class="row"><span>Used</span><b>${percent}%</b></div>` : ''}
    ${speed ? `<div class="row"><span>Last speed</span><b>${speed.toFixed(1)} tokens/s</b></div>` : ''}
    <div style="margin-top:8px;color:var(--text-3)">${busy ? 'Counting as the reply streams.'
      : exact ? 'Counted by the model after the last reply.' : 'Estimated: the exact count comes with the next reply.'}</div>`;
}

// ---------------------------------------------------------------- thread

function renderAll() {
  renderTopbar();
  renderHistory();
  renderThread();
  renderAttachments();
  updateSend();
}

function renderThread() {
  const box = $('messages');
  box.innerHTML = '';
  const messages = state.current.data.messages;
  if (!messages.length) {
    box.append(emptyState());
    return;
  }
  const lastAssistant = messages.map(m => m.role).lastIndexOf('assistant');
  messages.forEach((m, i) => {
    const turn = m.role === 'user' ? userTurn(m) : assistantTurn(m, i === lastAssistant);
    m._node = turn;
    box.append(turn);
  });
  if (state.notice) box.append(state.notice);
}

function emptyState() {
  const wrap = el('div', 'empty');
  const h = el('h1');
  h.textContent = 'What can I help with?';
  const p = el('p');
  const model = modelInfo(state.current.data.model);
  p.textContent = `${state.current.data.model}${model?.saias?.model ? ` · ${model.saias.model}` : ''} · private, on this PC`;
  const grid = el('div', 'suggestions');
  for (const [title, rest] of SUGGESTIONS) {
    const b = el('button', 'suggestion');
    b.type = 'button';
    b.innerHTML = '<b></b><span></span>';
    b.querySelector('b').textContent = title;
    b.querySelector('span').textContent = rest;
    b.addEventListener('click', () => {
      $('input').value = `${title} ${rest}`;
      autosize();
      updateSend();
      $('input').focus();
    });
    grid.append(b);
  }
  wrap.append(h, p, grid);
  return wrap;
}

function userTurn(m) {
  const turn = el('div', 'turn user');
  if (m.attachments?.length) {
    const files = el('div', 'user-files');
    for (const a of m.attachments) {
      if (a.image_url) {
        const img = el('img');
        img.src = a.image_url;
        img.alt = a.name;
        files.append(img);
      } else {
        const chip = el('div', 'file-chip', icons.file + '<span></span>');
        chip.querySelector('span').textContent = a.name;
        files.append(chip);
      }
    }
    turn.append(files);
  }
  if (m.content) {
    const bubble = el('div', 'bubble');
    bubble.textContent = m.content;
    turn.append(bubble);
  }
  const actions = el('div', 'turn-actions');
  actions.append(actionButton(icons.copy, 'Copy', () => copy(m.content)));
  turn.append(actions);
  return turn;
}

function actionButton(icon, label, onClick) {
  const b = el('button', 'action', icon);
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.addEventListener('click', onClick);
  return b;
}

function assistantTurn(m, last) {
  const turn = el('div', 'turn assistant' + (last ? ' last' : ''));
  fillAssistant(turn, m, last);
  return turn;
}

function toolCard(call) {
  const running = call._running;
  const card = el('details', 'tool' + (running ? ' running' : '') + (call.failed ? ' failed' : ''));
  if (call._open) card.open = true;
  let args = {};
  try { args = JSON.parse(call.arguments || '{}'); } catch { /* shown raw */ }
  const arg = args.query || args.url || Object.values(args).find(v => typeof v === 'string') || call.arguments || '';
  const icon = call.name === 'web_fetch' ? icons.page : call.name === 'web_search' ? icons.search : icons.globe;
  const summary = el('summary', null, `<span class="tool-icon">${call.failed ? icons.warn : icon}</span>
    <span class="tool-main"><span class="tool-name"></span><span class="tool-arg"></span></span><span class="tool-state"></span>`);
  summary.querySelector('.tool-name').textContent = toolLabel(call.name);
  summary.querySelector('.tool-arg').textContent = arg;
  summary.querySelector('.tool-state').innerHTML = running ? '<span class="pulse">Running…</span>'
    : call.failed ? 'Failed' : `${compact((call.result || '').length)} chars`;
  summary.addEventListener('click', () => { call._open = !card.open; });
  card.append(summary);
  if (!running) {
    const pre = el('pre');
    pre.textContent = call.result || '';
    card.append(pre);
  }
  return card;
}

function fillAssistant(turn, m, last) {
  const live = state.busy && state.busy.reply === m;
  turn.innerHTML = '';
  const head = el('div', 'assistant-head', '<span class="avatar">S</span><span class="speaker"></span>');
  head.querySelector('.speaker').textContent = m.model || state.current.data.model;
  turn.append(head);

  if (m.reasoning) {
    const thinking = el('details', 'thinking');
    const stillThinking = live && Boolean(m._thinkStart) && !m._thinkEnd && !m._pending;
    // Open while the model first thinks, folded once it acts or answers, unless the reader chose.
    thinking.open = m._thinkOpen ?? (stillThinking && !(m.tool_rounds || []).length);
    const seconds = m.thought_seconds ?? (m._thinkEnd && m._thinkStart ? (m._thinkEnd - m._thinkStart) / 1000 : null);
    const label = stillThinking ? '<span class="pulse">Thinking…</span>'
      : seconds ? `Thought for ${seconds < 60 ? `${Math.max(1, Math.round(seconds))} s` : `${Math.round(seconds / 60)} min`}` : 'Reasoning';
    thinking.innerHTML = `<summary>${label}${icons.chevron}</summary><div class="thought"></div>`;
    thinking.querySelector('.thought').textContent = m.reasoning;
    thinking.querySelector('summary').addEventListener('click', () => { m._thinkOpen = !thinking.open; });
    turn.append(thinking);
  }
  for (const round of m.tool_rounds || []) {
    if (round.text) turn.append(el('div', 'md', md.render(round.text)));
    for (const call of round.calls || []) turn.append(toolCard(call));
  }
  const text = live ? (m._pending || '') : (m.content || '');
  if (text) {
    const body = el('div', 'md' + (live ? ' cursor' : ''), md.render(text));
    turn.append(body);
  } else if (live && (m._waiting || (!m.reasoning && !(m.tool_rounds || []).length))) {
    const wait = m._loading ? 'Loading the model…' : m._waiting ? 'Reading the results…' : 'Thinking…';
    turn.append(el('div', 'md', `<p class="pulse" style="color:var(--text-3)">${wait}</p>`));
  }
  if (m._error) {
    const n = el('div', 'notice');
    n.textContent = m._error;
    turn.append(n);
  }
  if (!live) {
    const actions = el('div', 'turn-actions');
    actions.append(actionButton(icons.copy, 'Copy', () => copy(fullText(m))));
    if (last) actions.append(actionButton(icons.retry, 'Regenerate', regenerate));
    if (m.stats?.speed) {
      const s = el('span', 'stats');
      s.textContent = `${thousands(m.stats.tokens)} tokens · ${m.stats.speed.toFixed(1)} tokens/s`;
      actions.append(s);
    }
    turn.append(actions);
  }
}

function fullText(m) {
  return [...(m.tool_rounds || []).map(r => r.text).filter(Boolean), m.content || ''].join('\n\n').trim();
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text || '');
    toast('Copied');
  } catch {
    toast('Could not copy');
  }
}

function nearBottom() {
  const t = $('thread');
  return t.scrollHeight - t.scrollTop - t.clientHeight < 120;
}

function scrollToBottom(force) {
  const t = $('thread');
  if (force || nearBottom()) t.scrollTop = t.scrollHeight;
}

// Live updates are batched to one redraw per frame.
let frame = 0;
function refreshLive() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const busy = state.busy;
    if (!busy || state.current.id !== busy.id) return;
    const follow = nearBottom();
    const m = busy.reply;
    if (m._node && m._node.isConnected) fillAssistant(m._node, m, true);
    renderGauge();
    if (follow) scrollToBottom(true);
  });
}

// ---------------------------------------------------------------- request building

function systemPrompt() {
  let system = state.settings.system_prompt || '';
  if (state.settings.memory) system += (system ? '\n\n' : '') + `User-provided memory:\n${state.settings.memory}`;
  return system;
}

function userContent(m, vision) {
  let text = m.content || '';
  const images = [];
  for (const a of m.attachments || []) {
    if (a.image_url && vision) {
      images.push({ type: 'image_url', image_url: { url: a.image_url } });
    } else {
      if (text) text += '\n\n';
      text += a.image_url ? `[Earlier image attachment: ${a.name}]`
        : `[${/\.pdf$/i.test(a.name) ? 'PDF' : 'File'} attachment: ${a.name}]\n${a.text}\n[End ${/\.pdf$/i.test(a.name) ? 'PDF' : 'file'} attachment]`;
    }
  }
  if (!images.length) return text;
  return text ? [{ type: 'text', text }, ...images] : images;
}

function assistantMessages(m, final) {
  const out = [];
  for (const round of m.tool_rounds || []) {
    out.push({
      role: 'assistant',
      content: round.text || null,
      tool_calls: round.calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } })),
    });
    for (const c of round.calls) out.push({ role: 'tool', tool_call_id: c.id, content: c.result || '' });
  }
  if (final && (m.content || !(m.tool_rounds || []).length)) out.push({ role: 'assistant', content: m.content || '' });
  return out;
}

function buildRequest(data, reply, tools) {
  const model = modelInfo(data.model);
  const vision = Boolean(model?.saias?.vision);
  const messages = [];
  const system = systemPrompt();
  if (system) messages.push({ role: 'system', content: system });
  for (const m of data.messages) {
    if (m === reply) { messages.push(...assistantMessages(m, false)); continue; }
    if (m.role === 'user') messages.push({ role: 'user', content: userContent(m, vision) });
    else if (m.role === 'assistant' && !m._error) messages.push(...assistantMessages(m, true));
  }
  const body = { model: data.model, messages, stream: true, stream_options: { include_usage: true } };
  if (tools.length) body.tools = tools.map(t => t.definition);
  if (data.reasoning && data.reasoning !== 'default') body.reasoning_effort = data.reasoning;
  return body;
}

// ---------------------------------------------------------------- streaming and tools

async function streamRound(body, signal, reply, busy) {
  const res = await fetch('/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
  });
  reply._loading = false;
  if (!res.ok) {
    let message = `Server error ${res.status}`;
    try { const j = await res.json(); message = j.error?.message || message; } catch { /* not JSON */ }
    throw new Error(message);
  }
  const round = { calls: [], usage: null, timings: null };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  let firstThought = true;
  while (!done) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') { done = true; break; }
      let json;
      try { json = JSON.parse(payload); } catch { continue; }
      if (json.error) throw new Error(json.error.message || 'The model server reported an error.');
      if (json.usage) round.usage = json.usage;
      if (json.timings) round.timings = json.timings;
      const delta = json.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.reasoning_content || delta.reasoning || delta.content || delta.tool_calls) reply._waiting = false;
      const thought = delta.reasoning_content || delta.reasoning;
      if (thought) {
        reply._thinkStart ||= performance.now();
        // Each round's reasoning starts a new paragraph.
        if (firstThought && reply.reasoning && !reply.reasoning.endsWith('\n')) reply.reasoning += '\n\n';
        firstThought = false;
        reply._thinkEnd = 0;
        reply.reasoning = (reply.reasoning || '') + thought;
        busy.chars += thought.length;
      }
      if (delta.content) {
        if (reply._thinkStart && !reply._thinkEnd) reply._thinkEnd = performance.now();
        reply._pending = (reply._pending || '') + delta.content;
        busy.chars += delta.content.length;
      }
      for (const t of delta.tool_calls || []) {
        const i = Number.isInteger(t.index) ? t.index : round.calls.length;
        round.calls[i] ||= { id: '', name: '', arguments: '' };
        if (t.id) round.calls[i].id = t.id;
        if (t.function?.name) round.calls[i].name = t.function.name;
        if (t.function?.arguments) round.calls[i].arguments += t.function.arguments;
      }
      refreshLive();
    }
  }
  round.calls = round.calls.filter(c => c && c.name);
  return round;
}

async function runTool(call, signal) {
  let params = {};
  try {
    params = call.arguments ? JSON.parse(call.arguments) : {};
    if (typeof params !== 'object' || Array.isArray(params) || !params) throw new Error();
  } catch {
    return { result: 'The tool arguments were not valid JSON. Call the tool again with a JSON object.', failed: true };
  }
  try {
    const res = await fetch('/tools', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: call.name, params }), signal,
    });
    const json = await res.json().catch(() => ({}));
    const text = json.plain_text_response;
    if (!res.ok || typeof text !== 'string') {
      return { result: `The tool failed: ${json.error?.message || `HTTP ${res.status}`}`, failed: true };
    }
    return { result: text.length > TOOL_RESULT_LIMIT ? text.slice(0, TOOL_RESULT_LIMIT) + '\n[Truncated]' : text, failed: false };
  } catch (e) {
    if (signal.aborted) throw e;
    return { result: `The tool could not run: ${e.message}`, failed: true };
  }
}

async function respond() {
  const conversation = state.current;
  const data = conversation.data;
  const model = modelInfo(data.model);
  const reply = { role: 'assistant', model: data.model, content: '', reasoning: '', tool_rounds: [] };
  reply._loading = model && model.status?.value !== 'loaded';
  data.messages.push(reply);
  state.notice = null;
  const busy = {
    id: conversation.id, reply, controller: new AbortController(),
    base: data.context_tokens || estimateTokens(data), chars: 0, started: performance.now(), tokens: 0,
  };
  state.busy = busy;
  updateSend();
  renderThread();
  renderGauge();
  scrollToBottom(true);
  setStatus(reply._loading ? `Loading ${data.model}…` : '');

  const tools = enabledTools();
  let speed = 0;
  try {
    for (let step = 0; ; step++) {
      const body = buildRequest(data, reply, step < MAX_TOOL_ROUNDS ? tools : []);
      const round = await streamRound(body, busy.controller.signal, reply, busy);
      setStatus('');
      if (round.usage) {
        data.context_tokens = (round.usage.prompt_tokens || 0) + (round.usage.completion_tokens || 0);
        busy.base = data.context_tokens;
        busy.chars = 0;
        busy.tokens += round.usage.completion_tokens || 0;
      }
      if (round.timings?.predicted_per_second) speed = round.timings.predicted_per_second;
      if (!round.calls.length) {
        reply.content = reply._pending || '';
        reply._pending = '';
        break;
      }
      if (reply._thinkStart && !reply._thinkEnd) reply._thinkEnd = performance.now();
      const entry = { text: reply._pending || '', calls: [] };
      reply._pending = '';
      reply.tool_rounds.push(entry);
      for (const [i, c] of round.calls.entries()) {
        const call = { id: c.id || `call_${step}_${i}`, name: c.name, arguments: c.arguments || '{}', result: '', failed: false, _running: true };
        entry.calls.push(call);
        refreshLive();
        setStatus(`Running ${toolLabel(call.name)}…`);
        const out = await runTool(call, busy.controller.signal);
        call.result = out.result;
        call.failed = out.failed;
        call._running = false;
        busy.chars += out.result.length;
        refreshLive();
      }
      reply._waiting = true;
      setStatus('Reading the results…');
      refreshLive();
    }
  } catch (e) {
    if (reply._pending) reply.content = reply._pending;
    reply._pending = '';
    for (const r of reply.tool_rounds) for (const c of r.calls) if (c._running) { c._running = false; c.failed = true; c.result ||= 'Stopped.'; }
    if (busy.controller.signal.aborted) {
      setStatus('Stopped.');
    } else {
      reply._error = /Failed to fetch|NetworkError/i.test(e.message)
        ? 'SAIAS is not responding. Make sure it is running (Start-SAIAS.cmd or the SAIAS app).'
        : e.message;
    }
  }
  if (reply._thinkStart) reply.thought_seconds = ((reply._thinkEnd || performance.now()) - reply._thinkStart) / 1000;
  if (speed) {
    reply.stats = { tokens: busy.tokens, speed };
    state.speed = { value: speed, id: conversation.id };
  }
  state.busy = null;
  const empty = !reply.content && !reply.tool_rounds.length;
  if (empty) {
    data.messages.splice(data.messages.indexOf(reply), 1);
    if (reply._error) {
      state.notice = el('div', 'notice');
      state.notice.textContent = reply._error;
    }
  }
  if (model) model.status = { value: 'loaded' };
  if (state.current === conversation) {
    renderThread();
    renderTopbar();
    updateSend();
    scrollToBottom(false);
  }
  await save();
}

async function send() {
  if (state.busy) { state.busy.controller.abort(); return; }
  const input = $('input');
  const text = input.value.trim();
  if (!text && !state.attachments.length) return;
  const data = state.current.data;
  const model = modelInfo(data.model);
  if (!model) { setStatus('This model is not installed. Choose another one.', true); return; }
  if (state.attachments.some(a => a.image_url) && !model.saias?.vision) {
    setStatus(`${data.model} cannot see images. Remove them or choose a model with image support.`, true);
    return;
  }
  data.messages.push({
    role: 'user', content: text,
    ...(state.attachments.length ? { attachments: state.attachments.map(a => (a.image_url ? { name: a.name, image_url: a.image_url } : { name: a.name, text: a.text })) } : {}),
  });
  input.value = '';
  state.attachments = [];
  autosize();
  renderAttachments();
  await respond();
}

async function regenerate() {
  if (state.busy) return;
  const messages = state.current.data.messages;
  const lastUser = messages.map(m => m.role).lastIndexOf('user');
  if (lastUser < 0) return;
  messages.splice(lastUser + 1);
  state.notice = null;
  await respond();
}

function updateSend() {
  const button = $('send');
  const busy = Boolean(state.busy);
  button.classList.toggle('stop', busy);
  button.title = busy ? 'Stop' : 'Send (Enter)';
  button.setAttribute('aria-label', busy ? 'Stop' : 'Send');
  button.disabled = !busy && !$('input').value.trim() && !state.attachments.length;
}

// ---------------------------------------------------------------- attachments

const TEXT_LIMIT = 400000;

function readAs(file, how) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    if (how === 'url') r.readAsDataURL(file); else if (how === 'buffer') r.readAsArrayBuffer(file); else r.readAsText(file);
  });
}

// Large photos are scaled down: the models see at most about 1.5 megapixels anyway.
async function imageUrl(file) {
  const url = await readAs(file, 'url');
  const img = new Image();
  await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = url; });
  const max = 1600;
  if (img.width <= max && img.height <= max && file.size < 3e6) return url;
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.88);
}

async function addFiles(files) {
  for (const file of files) {
    if (state.attachments.length >= 8) { setStatus('Up to 8 attachments per message.', true); break; }
    try {
      if (file.type.startsWith('image/')) {
        state.attachments.push({ name: file.name, image_url: await imageUrl(file), size: file.size, kind: 'image' });
      } else if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
        setStatus(`Reading ${file.name}…`);
        const buffer = await readAs(file, 'buffer');
        const out = await api(`${API}/extract`, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: buffer });
        state.attachments.push({ name: file.name, text: out.text.slice(0, TEXT_LIMIT), size: file.size, kind: 'pdf', pages: out.pages });
        setStatus('');
      } else {
        const text = await readAs(file, 'text');
        if (/\u0000/.test(text.slice(0, 2000))) throw new Error('this file is not text');
        state.attachments.push({ name: file.name, text: text.slice(0, TEXT_LIMIT), size: file.size, kind: 'text' });
      }
    } catch (e) {
      setStatus(`${file.name}: ${e.message}`, true);
    }
  }
  renderAttachments();
  updateSend();
}

function renderAttachments() {
  const box = $('attachments');
  box.innerHTML = '';
  box.hidden = !state.attachments.length;
  state.attachments.forEach((a, i) => {
    const item = el('div', 'attachment');
    if (a.image_url) {
      const img = el('img');
      img.src = a.image_url;
      img.alt = '';
      item.append(img);
    } else {
      item.append(el('span', 'file-icon', icons.file));
    }
    const label = el('span');
    label.innerHTML = '<span class="name"></span><span class="meta"></span>';
    label.querySelector('.name').textContent = a.name;
    label.querySelector('.meta').textContent = a.kind === 'pdf' ? `PDF · ${a.pages} pages` : a.kind === 'image' ? 'Image' : `${compact(a.text.length)} characters`;
    const remove = el('button', 'remove', icons.close);
    remove.type = 'button';
    remove.title = 'Remove';
    remove.addEventListener('click', () => { state.attachments.splice(i, 1); renderAttachments(); updateSend(); });
    item.append(label, remove);
    box.append(item);
  });
}

// ---------------------------------------------------------------- composer and events

function autosize() {
  const input = $('input');
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 220) + 'px';
}

function bind() {
  const input = $('input');
  input.addEventListener('input', () => { autosize(); updateSend(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!state.busy) send();
    }
  });
  input.addEventListener('paste', e => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  $('send').addEventListener('click', send);
  $('attach').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', e => { addFiles([...e.target.files]); e.target.value = ''; });
  $('new-chat').addEventListener('click', newConversation);
  $('search').addEventListener('input', renderHistory);
  $('model-button').addEventListener('click', () => toggleMenu('model-menu', renderModelMenu));
  $('reasoning-button').addEventListener('click', () => toggleMenu('reasoning-menu', renderReasoningMenu));
  $('tools-button').addEventListener('click', () => toggleMenu('tools-menu', renderToolsMenu));
  document.addEventListener('click', e => { if (!e.target.closest('.picker')) closeMenus(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeMenus();
      if (!$('settings').hidden) $('settings').hidden = true;
      else if (state.busy) state.busy.controller.abort();
    }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); newConversation(); }
  });
  $('messages').addEventListener('click', e => {
    const button = e.target.closest('.copy-code');
    if (button) copy(button.closest('.code').querySelector('code').textContent);
  });

  const app = $('app');
  const collapsed = localStorage.getItem('saias.sidebar') === 'hidden' || window.innerWidth < 860;
  app.classList.toggle('collapsed', collapsed);
  $('collapse').addEventListener('click', () => { app.classList.add('collapsed'); localStorage.setItem('saias.sidebar', 'hidden'); });
  $('expand').addEventListener('click', () => { app.classList.remove('collapsed'); localStorage.setItem('saias.sidebar', 'shown'); });

  $('open-settings').addEventListener('click', () => {
    $('memory').value = state.settings.memory;
    $('system-prompt').value = state.settings.system_prompt;
    $('settings').hidden = false;
    $('memory').focus();
  });
  $('settings-cancel').addEventListener('click', () => { $('settings').hidden = true; });
  $('settings').addEventListener('click', e => { if (e.target === $('settings')) $('settings').hidden = true; });
  $('settings-save').addEventListener('click', async () => {
    state.settings.memory = $('memory').value.trim();
    state.settings.system_prompt = $('system-prompt').value.trim();
    await saveSettings();
    $('settings').hidden = true;
    toast('Saved. Applies to your next message.');
  });

  let depth = 0;
  window.addEventListener('dragenter', e => { if (e.dataTransfer?.types?.includes('Files')) { depth++; $('drop').hidden = false; } });
  window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; $('drop').hidden = true; } });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault();
    depth = 0;
    $('drop').hidden = true;
    if (e.dataTransfer?.files?.length) addFiles([...e.dataTransfer.files]);
  });
}

async function start() {
  bind();
  try {
    await Promise.all([loadModels(), loadTools(), loadSettings()]);
  } catch (e) {
    state.current = blankConversation();
    renderAll();
    state.notice = el('div', 'notice');
    state.notice.textContent = 'SAIAS is not responding. Start it with Start-SAIAS.cmd or the SAIAS app, then reload this page.';
    renderThread();
    return;
  }
  state.current = blankConversation();
  await loadList();
  renderAll();
  $('input').focus();
}

start();
