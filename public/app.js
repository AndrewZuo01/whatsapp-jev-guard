const $ = (selector) => document.querySelector(selector);
const state = { messages: [], logs: [], selected: null, filter: 'all' };
const labels = { safe: 'No obvious risk', suspicious: 'Suspicious', high: 'High risk', critical: 'Critical', unknown: 'Pending', pending: 'Retrying', unavailable: 'Unavailable', error: 'Error', not_reviewed: 'Skipped' };

function escapeHtml(value = '') { return String(value).replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' }[char])); }
function showToast(text) { const toast = $('#toast'); toast.textContent = text; toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 3200); }
function setConnection(connection, data = {}) {
  const el = $('#connection'); el.className = `pill ${connection === 'connected' ? 'connected' : connection === 'qr' ? 'warning' : 'muted'}`;
  el.textContent = ({ connected:'Connected', qr:'Waiting for scan', connecting:'Connecting…', reconnecting:'Reconnecting…', disconnected:'Disconnected' }[connection] || connection);
  $('#connectBtn').hidden = connection === 'connected' || connection === 'connecting' || connection === 'qr';
  $('#connectBtn').textContent = data.reauthRequired ? 'Clear session and scan again' : 'Connect WhatsApp';
  $('#disconnectBtn').hidden = !(connection === 'connected' || connection === 'qr' || connection === 'reconnecting');
}
function updateSetup(data) {
  setConnection(data.connection, data);
  $('#userName').textContent = data.user?.name || 'Disconnected';
  $('#jevStatus').textContent = `${data.jevConfigured ? 'Jev ready' : 'Jev fallback'} · ${data.openaiConfigured ? 'GPT ready' : 'GPT not configured'}`;
  $('#reviewUnknownOnly').checked = data.reviewUnknownOnly !== false;
  $('#reviewOutgoing').checked = data.reviewOutgoing === true;
  $('#forceStrangerMode').checked = data.forceStrangerMode === true;
  if (data.qr) $('#qrWrap').innerHTML = `<img src="${data.qr}" alt="WhatsApp login QR code" />`;
  else if (data.connection === 'connected') $('#qrWrap').innerHTML = '<div class="qr-placeholder">WhatsApp connected</div>';
  else if (data.reauthRequired) $('#qrWrap').innerHTML = `<div class="qr-placeholder">${escapeHtml(data.connectionError || 'Login expired')}<br /><br />Click the top-right button to clear the old session</div>`;
  else if (data.connectionError) $('#qrWrap').innerHTML = `<div class="qr-placeholder">${escapeHtml(data.connectionError)}</div>`;
  if (Array.isArray(data.messages)) { state.messages = data.messages; renderList(); updateStats(); }
  if (Array.isArray(data.logs)) { state.logs = data.logs; renderLogs(state.logs); }
}
function renderLogs(logs) {
  $('#logList').innerHTML = logs.length ? logs.slice(0, 100).map((entry) => `<div class="log-row"><span class="log-time">${escapeHtml(new Date(entry.timestamp).toLocaleString())}</span><span class="log-level ${escapeHtml(entry.level)}">${escapeHtml(entry.level)}</span><span class="log-message" title="${escapeHtml(entry.message)}">${escapeHtml(entry.message)}</span></div>`).join('') : '<div class="empty">No runtime logs yet</div>';
}
function updateStats() { $('#totalCount').textContent = state.messages.length; $('#riskCount').textContent = state.messages.filter((m) => ['high','critical'].includes(m.analysis?.level)).length; }
function visibleMessages() {
  return state.messages.filter((item) => state.filter === 'all' || (state.filter === 'risk' ? ['high','critical','suspicious'].includes(item.analysis?.level) : item.analysis?.level === 'critical'));
}
function renderList() {
  const items = visibleMessages();
  $('#messageList').innerHTML = items.length ? items.map((item) => {
    const level = item.analysis?.level || 'unknown';
    const badge = item.analysis ? `<span class="pill ${level === 'critical' ? 'critical' : level === 'high' || level === 'suspicious' ? 'warning' : 'muted'}">${labels[level]}</span>` : `<span class="pill muted">${item.status === 'queued' ? 'Queued' : 'Analyzing'}</span>`;
    const translation = item.translation?.text ? `<div class="translation-preview"><span>English</span>${escapeHtml(item.translation.text)}</div>` : '';
    return `<div class="message-item ${state.selected === item.id ? 'selected' : ''}" data-id="${escapeHtml(item.id)}"><div class="message-item-top"><strong>${escapeHtml(item.chat || item.sender)}</strong>${badge}</div><div class="message-snippet">${escapeHtml(item.text)}</div>${translation}<div class="message-time">${new Date(item.timestamp).toLocaleString()}</div><div class="message-actions"><button type="button" class="message-select secondary">View analysis</button><button type="button" class="translate-button secondary" data-id="${escapeHtml(item.id)}">${item.translation?.text ? 'Translated' : 'Translate to English'}</button></div></div>`;
  }).join('') : '<div class="empty">No messages match this filter</div>';
  document.querySelectorAll('.message-item').forEach((card) => {
    card.addEventListener('click', () => { state.selected = card.dataset.id; renderList(); renderDetail(); });
    card.querySelector('.message-select').addEventListener('click', (event) => { event.stopPropagation(); state.selected = card.dataset.id; renderList(); renderDetail(); });
  });
  document.querySelectorAll('.translate-button').forEach((button) => button.addEventListener('click', async (event) => {
    event.stopPropagation();
    if (button.textContent === 'Translated') return;
    button.disabled = true;
    button.textContent = 'Translating…';
    try {
      const response = await fetch(`/api/messages/${encodeURIComponent(button.dataset.id)}/translate`, { method: 'POST' });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'Translation failed');
      const localItem = state.messages.find((message) => message.id === button.dataset.id);
      if (localItem) localItem.translation = result.translation;
      upsertMessage(localItem);
      showToast('English translation ready');
    } catch (error) {
      button.disabled = false;
      button.textContent = 'Translate to English';
      showToast(error.message);
    }
  }));
}
function renderDetail() {
  const item = state.messages.find((m) => m.id === state.selected);
  if (!item) { $('#detailEmpty').hidden = false; $('#detailBody').hidden = true; $('#detailStatus').textContent = 'Select a message'; return; }
  $('#detailEmpty').hidden = true; $('#detailBody').hidden = false;
  const analysis = item.analysis || (item.status === 'skipped' ? { level:'not_reviewed', score:null, reasons:['No model was called for this message.'], recommendation:'Review was skipped by the current settings.' } : { level:'unknown', score:null, reasons:['Jev is analyzing this message…'], recommendation:'Please wait.' });
  const level = analysis.level; const score = analysis.score == null ? '—' : `${analysis.score}`;
  $('#detailStatus').className = `pill ${level === 'critical' ? 'critical' : level === 'high' || level === 'suspicious' ? 'warning' : 'muted'}`; $('#detailStatus').textContent = item.status === 'analyzing' ? 'Analyzing' : labels[level];
  $('#riskBanner').className = `risk-banner ${level}`; $('#riskBanner').innerHTML = `<div><div class="risk-title">Jev: ${labels[level]}</div><div>${escapeHtml(analysis.source || 'Jev')}</div></div><div class="risk-score">${score}<small>/100</small></div>`;
  $('#detailMeta').textContent = `${escapeHtml(item.chat)} · ${escapeHtml(item.sender)} · ${new Date(item.timestamp).toLocaleString()}`; $('#detailText').textContent = item.text;
  const account = item.account;
  $('#accountSignals').innerHTML = account ? [
    ['Saved contact', account.isSavedContact ? `Yes: ${account.contactName || 'Unnamed'}` : 'No', account.isSavedContact ? 'good' : 'caution'],
    ['Business identity', account.hasVerifiedBusinessIdentity ? `Verified: ${account.verifiedBusinessName}` : account.hasBusinessProfile ? 'Business profile, not verified' : 'No business profile', account.hasVerifiedBusinessIdentity ? 'good' : ''],
    ['Account name', account.profileName || 'Not provided', ''],
    ['Message history', account.isFirstSeenThisRun ? 'First seen in this run' : `${account.previousMessagesThisRun} prior messages`, account.isFirstSeenThisRun ? 'caution' : ''],
    ['Business category', account.businessCategory || 'Not provided', ''],
    ['Country code', account.countryCallingCode ? `+${account.countryCallingCode}` : 'Unknown', ''],
  ].map(([name,value,kind]) => `<div class="account-signal ${kind}"><span>${escapeHtml(name)}</span><strong>${escapeHtml(value)}</strong></div>`).join('') : item.status === 'skipped' ? '<div class="account-signal"><span>Status</span><strong>Not required because model review was skipped.</strong></div>' : '<div class="account-signal"><span>Status</span><strong>Reading account signals…</strong></div>';
  const comparison = item.comparison;
  document.querySelector('.comparison-card')?.remove();
  if (comparison) {
    const comparisonReasons = (comparison.reasons || []).map((reason) => `<li>${escapeHtml(reason)}</li>`).join('');
    const firstTurn = comparison.firstScamTurn ? `First material scam signal: turn ${comparison.firstScamTurn}` : 'First scam turn: not identified';
    const retryable = ['error', 'unavailable'].includes(comparison.level) || String(comparison.source || '').startsWith('openai-not-');
    const card = document.createElement('div');
    card.className = 'comparison-card';
    card.innerHTML = `<div class="comparison-head"><strong>GPT comparison (${escapeHtml(comparison.source || 'gpt-5.6-luna')})</strong><span>${labels[comparison.level] || comparison.level}</span></div><div class="comparison-score">${comparison.score == null ? '—' : comparison.score}<small>/100</small></div><div class="comparison-meta">${escapeHtml(firstTurn)}${comparison.turningPoint ? ` · ${escapeHtml(comparison.turningPoint)}` : ''}</div><ul class="reasons">${comparisonReasons}</ul>${retryable ? '<button type="button" class="secondary retry-gpt-button">Retry GPT evaluation</button>' : ''}`;
    $('#reasons').before(card);
    const retryButton = card.querySelector('.retry-gpt-button');
    retryButton?.addEventListener('click', async () => {
      retryButton.disabled = true;
      retryButton.textContent = 'Retrying…';
      try {
        const response = await fetch(`/api/messages/${encodeURIComponent(item.id)}/retry-gpt`, { method: 'POST' });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || 'GPT retry failed');
        item.comparison = result.comparison;
        upsertMessage(item);
        showToast('GPT evaluation completed');
      } catch (error) {
        retryButton.disabled = false;
        retryButton.textContent = 'Retry GPT evaluation';
        showToast(error.message);
      }
    });
  }
  $('#reasons').innerHTML = (analysis.reasons || []).map((reason) => `<li>${escapeHtml(reason)}</li>`).join(''); $('#recommendation').textContent = analysis.recommendation || 'Verify through an official channel.';
}
function upsertMessage(item) { const index = state.messages.findIndex((m) => m.id === item.id); if (index >= 0) state.messages[index] = item; else state.messages.unshift(item); updateStats(); renderList(); if (state.selected === item.id) renderDetail(); }

$('#filter').addEventListener('change', (event) => { state.filter = event.target.value; renderList(); });
$('#connectBtn').addEventListener('click', async () => { $('#connectBtn').disabled = true; await fetch('/api/connect', { method:'POST' }); $('#connectBtn').disabled = false; showToast('Connecting to WhatsApp…'); });
$('#disconnectBtn').addEventListener('click', async () => { await fetch('/api/disconnect', { method:'POST' }); showToast('WhatsApp disconnected'); });
async function loadSettings() {
  try {
    const response = await fetch('/api/settings');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Settings could not be loaded');
    $('#model').value = data.model || 'jev-latest';
    $('#apiUrl').value = data.apiUrl || 'https://api.typesafe.ai/v1/systemone';
    $('#openaiModel').value = data.openaiModel || 'gpt-5.6-luna';
    $('#openaiApiUrl').value = data.openaiApiUrl || 'https://api.openai.com/v1/responses';
    $('#whatsappProxyUrl').value = data.whatsappProxyUrl || '';
    $('#reviewUnknownOnly').checked = data.reviewUnknownOnly !== false;
    $('#reviewOutgoing').checked = data.reviewOutgoing === true;
    $('#forceStrangerMode').checked = data.forceStrangerMode === true;
    $('#apiKey').value = '';
    $('#openaiApiKey').value = '';
    $('#apiKey').placeholder = data.jevConfigured ? 'Leave blank to keep the saved key' : 'Optional: local fallback is used when empty';
    $('#openaiApiKey').placeholder = data.openaiConfigured ? 'Leave blank to keep the saved key' : 'Required for GPT comparison and translation';
  } catch (error) {
    showToast(error.message);
  }
}
$('#settingsBtn').addEventListener('click', async () => { await loadSettings(); $('#settingsDialog').showModal(); });
$('#settingsForm').addEventListener('submit', async (event) => { event.preventDefault(); const response = await fetch('/api/settings', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ apiKey:$('#apiKey').value, model:$('#model').value, apiUrl:$('#apiUrl').value, openaiApiKey:$('#openaiApiKey').value, openaiModel:$('#openaiModel').value, openaiApiUrl:$('#openaiApiUrl').value, whatsappProxyUrl:$('#whatsappProxyUrl').value, reviewUnknownOnly:$('#reviewUnknownOnly').checked, reviewOutgoing:$('#reviewOutgoing').checked, forceStrangerMode:$('#forceStrangerMode').checked }) }); const result = await response.json(); if (!response.ok || !result.ok) { showToast(result.error || 'Settings could not be saved'); return; } $('#jevStatus').textContent = `${result.jevConfigured ? 'Jev ready' : 'Jev fallback'} · ${result.openaiConfigured ? 'GPT ready' : 'GPT not configured'}`; $('#settingsDialog').close(); showToast('Settings saved'); });
$('#falsePositiveBtn').addEventListener('click', () => showToast('Marked as a false positive (local demo)'));
$('#scamBtn').addEventListener('click', () => showToast('Marked as a scam (local demo; no automatic report or block)'));

const events = new EventSource('/api/events');
events.addEventListener('state', (event) => updateSetup(JSON.parse(event.data)));
events.addEventListener('message.update', (event) => { upsertMessage(JSON.parse(event.data)); });
events.addEventListener('log', (event) => { state.logs.unshift(JSON.parse(event.data)); state.logs = state.logs.slice(0, 100); renderLogs(state.logs); });
events.addEventListener('warning', (event) => { const item = JSON.parse(event.data); showToast(`${labels[item.analysis?.level] || 'Risk'} message from ${item.chat}`); });
fetch('/api/state').then((response) => response.json()).then(updateSetup).catch(() => showToast('Cannot connect to the local service'));
