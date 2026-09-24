import dotenv from 'dotenv';
import express from 'express';
import QRCode from 'qrcode';
import Pino from 'pino';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { HttpsProxyAgent } from 'https-proxy-agent';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IS_ELECTRON = Boolean(process.versions.electron);
const IS_PACKAGED = Boolean(process.pkg);
const RUNTIME_DIR = process.env.JEV_GUARD_DATA_DIR || (IS_PACKAGED ? path.dirname(process.execPath) : __dirname);
const ENV_FILE = process.env.JEV_GUARD_ENV_FILE || path.join(RUNTIME_DIR, '.env');
dotenv.config({ path: ENV_FILE });
if (!IS_PACKAGED && !IS_ELECTRON) dotenv.config();
const PORT = Number(process.env.PORT || 8787);
const AUTH_DIR = path.resolve(RUNTIME_DIR, process.env.AUTH_DIR || '.data/baileys-auth');
const MAX_MESSAGES = Number(process.env.MAX_MESSAGES || 200);
const MAX_TURNS_PER_CHAT = Number(process.env.MAX_TURNS_PER_CHAT || 12);
const MAX_RECONNECT_ATTEMPTS = Number(process.env.MAX_RECONNECT_ATTEMPTS || 3);
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 120000);
const WHATSAPP_PREFLIGHT_URL = process.env.WHATSAPP_PREFLIGHT_URL || 'https://web.whatsapp.com';
const LOG_DIR = path.resolve(RUNTIME_DIR, process.env.LOG_DIR || '.data/logs');
const LOG_FILE = path.join(LOG_DIR, 'app.log');
const SETTINGS_FILE = path.resolve(RUNTIME_DIR, '.data/settings.json');
function normaliseJevModel(value) {
  const model = String(value || '').trim();
  return !model || model === 'jev' ? 'jev-latest' : model;
}

function openBrowser(url) {
  if (process.env.NO_AUTO_BROWSER === 'true') return;
  if (IS_ELECTRON) return;
  if (!IS_PACKAGED && process.env.OPEN_BROWSER !== 'true') return;
  try {
    if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch (error) {
    writeLog('warn', 'Could not open the browser automatically', { error: error.message });
  }
}
fsSync.mkdirSync(LOG_DIR, { recursive: true });
fsSync.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
let persistedSettings = {};
try {
  persistedSettings = JSON.parse(fsSync.readFileSync(SETTINGS_FILE, 'utf8'));
} catch {}
for (const [envName, settingName] of [
  ['TYPESAFE_API_KEY', 'apiKey'],
  ['TYPESAFE_MODEL', 'model'],
  ['JEV_API_URL', 'apiUrl'],
  ['OPENAI_API_KEY', 'openaiApiKey'],
  ['OPENAI_MODEL', 'openaiModel'],
  ['OPENAI_API_URL', 'openaiApiUrl'],
  ['WHATSAPP_PROXY_URL', 'whatsappProxyUrl'],
]) {
  if (typeof persistedSettings[settingName] === 'string' && persistedSettings[settingName]) {
    process.env[envName] = settingName === 'model' ? normaliseJevModel(persistedSettings[settingName]) : persistedSettings[settingName];
  }
}
const logger = Pino({ level: process.env.LOG_LEVEL || 'warn' });
const fileLogger = Pino({ level: process.env.LOG_LEVEL || 'info' }, Pino.destination({ dest: LOG_FILE, sync: false }));

const state = {
  connection: 'disconnected',
  qr: null,
  user: null,
  reauthRequired: false,
  connectionError: null,
  messages: [],
  logs: [],
  clients: new Set(),
  socket: null,
  stopping: false,
  reconnectTimer: null,
  reconnectAttempts: 0,
  contacts: new Map(),
  businessProfiles: new Map(),
  senderCounts: new Map(),
  conversations: new Map(),
  initTimer: null,
  reviewUnknownOnly: persistedSettings.reviewUnknownOnly !== false,
  reviewOutgoing: persistedSettings.reviewOutgoing === true,
  forceStrangerMode: persistedSettings.forceStrangerMode === true,
};

function saveSettings() {
  const settings = {
    apiKey: process.env.TYPESAFE_API_KEY || '',
    model: normaliseJevModel(process.env.TYPESAFE_MODEL),
    apiUrl: process.env.JEV_API_URL || 'https://api.typesafe.ai/v1/systemone',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    openaiModel: process.env.OPENAI_MODEL || 'gpt-5.6-luna',
    openaiApiUrl: process.env.OPENAI_API_URL || 'https://api.openai.com/v1/responses',
    whatsappProxyUrl: process.env.WHATSAPP_PROXY_URL || '',
    reviewUnknownOnly: state.reviewUnknownOnly,
    reviewOutgoing: state.reviewOutgoing,
    forceStrangerMode: state.forceStrangerMode,
  };
  fsSync.writeFileSync(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  try { fsSync.chmodSync(SETTINGS_FILE, 0o600); } catch {}
}

function publicSettings() {
  return {
    model: normaliseJevModel(process.env.TYPESAFE_MODEL),
    apiUrl: process.env.JEV_API_URL || 'https://api.typesafe.ai/v1/systemone',
    openaiModel: process.env.OPENAI_MODEL || 'gpt-5.6-luna',
    openaiApiUrl: process.env.OPENAI_API_URL || 'https://api.openai.com/v1/responses',
    whatsappProxyUrl: process.env.WHATSAPP_PROXY_URL || '',
    jevConfigured: Boolean(process.env.TYPESAFE_API_KEY),
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
    reviewUnknownOnly: state.reviewUnknownOnly,
    reviewOutgoing: state.reviewOutgoing,
    forceStrangerMode: state.forceStrangerMode,
  };
}

function writeLog(level, message, meta = {}) {
  const entry = { timestamp: new Date().toISOString(), level, message, ...meta };
  state.logs.unshift(entry);
  state.logs = state.logs.slice(0, 100);
  logger[level]?.(meta, message);
  fileLogger[level]?.(meta, message);
  broadcast('log', entry);
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function broadcast(type, payload) {
  const packet = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const response of state.clients) response.write(packet);
}

function broadcastMessage(item) {
  broadcast('message.update', item);
}

function publicState() {
  return {
    connection: state.connection,
    qr: state.qr,
    user: state.user,
    reauthRequired: state.reauthRequired,
    connectionError: state.connectionError,
    reconnectAttempts: state.reconnectAttempts,
    messages: state.messages,
    logs: state.logs,
    jevConfigured: Boolean(process.env.TYPESAFE_API_KEY),
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
    reviewUnknownOnly: state.reviewUnknownOnly,
    reviewOutgoing: state.reviewOutgoing,
    forceStrangerMode: state.forceStrangerMode,
  };
}

function setConnection(connection, extra = {}) {
  state.connection = connection;
  broadcast('state', {
    connection,
    user: state.user,
    reauthRequired: state.reauthRequired,
    connectionError: state.connectionError,
    reconnectAttempts: state.reconnectAttempts,
    ...extra,
  });
}

function normaliseText(message) {
  const content = message?.message;
  if (!content) return '';
  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    ''
  ).trim();
}

function messageKind(message) {
  const content = message?.message || {};
  if (content.imageMessage) return 'image';
  if (content.audioMessage) return 'audio';
  if (content.videoMessage) return 'video';
  if (content.documentMessage) return 'document';
  return 'text';
}

function jidToLabel(jid) {
  if (!jid) return 'Unknown contact';
  if (jid.endsWith('@g.us')) return 'Group chat';
  return jid.replace(/@s\.whatsapp\.net$/, '');
}

function usableAccountName(...values) {
  for (const value of values) {
    const name = String(value || '').trim();
    if (!name || name === '~' || /^\+?[\d\s().:@_-]+$/.test(name)) continue;
    return name;
  }
  return 'WhatsApp account';
}

function accountUser(contact = {}, fallbackId = state.user?.id) {
  const id = contact.id || contact.jid || fallbackId || null;
  return id ? { id, name: usableAccountName(contact.name, contact.notify, contact.verifiedName) } : null;
}

function updateCurrentAccount(contact) {
  const next = accountUser(contact, state.user?.id);
  if (!next) return;
  const changed = !state.user || state.user.id !== next.id || state.user.name !== next.name;
  state.user = next;
  if (changed) broadcast('state', publicState());
}

function contactForJid(jid) {
  return state.contacts.get(jid) || null;
}

function rememberContacts(contacts = []) {
  for (const contact of contacts) {
    if (!contact?.id) continue;
    const current = state.contacts.get(contact.id) || {};
    const merged = { ...current, ...contact };
    for (const id of [merged.id, merged.jid, merged.lid].filter(Boolean)) state.contacts.set(id, merged);
  }
}

function countryCodeFromJid(jid) {
  if (!jid?.endsWith('@s.whatsapp.net')) return null;
  const digits = jid.split('@')[0].replace(/\D/g, '');
  const known = ['1', '7', '20', '27', '30', '31', '32', '33', '34', '36', '39', '40', '41', '43', '44', '45', '46', '47', '48', '49', '51', '52', '53', '54', '55', '56', '57', '58', '60', '61', '62', '63', '64', '65', '66', '81', '82', '84', '86', '90', '91', '92', '93', '94', '95', '98'];
  return known.sort((a, b) => b.length - a.length).find((code) => digits.startsWith(code)) || null;
}

async function getAccountSignals(item) {
  const isGroup = item.remoteJid.endsWith('@g.us');
  const senderJid = item.senderJid;
  const contact = contactForJid(senderJid);
  const phoneJid = contact?.jid || (senderJid?.endsWith('@s.whatsapp.net') ? senderJid : null);
  let businessProfile = phoneJid ? state.businessProfiles.get(phoneJid) : null;
  if (phoneJid && !contact?.name && businessProfile === undefined && state.socket) {
    try {
      businessProfile = await Promise.race([
        state.socket.getBusinessProfile(phoneJid),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Business profile lookup timed out')), 5000)),
      ]) || null;
    } catch {
      businessProfile = null;
    }
    state.businessProfiles.set(phoneJid, businessProfile);
  }
  const verifiedBusinessName = item.verifiedBizName || contact?.verifiedName || null;
  const previousMessages = state.senderCounts.get(senderJid) || 0;
  state.senderCounts.set(senderJid, previousMessages + 1);
  return {
    isGroup,
    isSavedContact: Boolean(contact?.name),
    contactName: contact?.name || null,
    profileName: contact?.notify || item.pushName || null,
    verifiedBusinessName,
    hasVerifiedBusinessIdentity: Boolean(verifiedBusinessName),
    hasBusinessProfile: Boolean(businessProfile),
    businessCategory: businessProfile?.category || null,
    businessWebsite: businessProfile?.website?.slice(0, 3) || [],
    businessEmail: businessProfile?.email || null,
    countryCallingCode: countryCodeFromJid(phoneJid),
    isFirstSeenThisRun: previousMessages === 0,
    previousMessagesThisRun: previousMessages,
    identityLevel: verifiedBusinessName ? 'verified_business' : businessProfile ? 'business_unverified' : contact?.name ? 'saved_contact' : 'unknown_sender',
  };
}

function fallbackAccountSignals(item, reason = 'Account profile lookup timed out') {
  const senderJid = item.senderJid || item.remoteJid || '';
  return {
    isGroup: item.remoteJid?.endsWith('@g.us') || false,
    isSavedContact: false,
    contactName: null,
    profileName: item.pushName || null,
    verifiedBusinessName: item.verifiedBizName || null,
    hasVerifiedBusinessIdentity: Boolean(item.verifiedBizName),
    hasBusinessProfile: false,
    businessCategory: null,
    businessWebsite: [],
    businessEmail: null,
    countryCallingCode: countryCodeFromJid(senderJid),
    isFirstSeenThisRun: true,
    previousMessagesThisRun: 0,
    identityLevel: item.verifiedBizName ? 'verified_business' : 'unknown_sender',
    lookupStatus: 'timeout',
    lookupNote: reason,
  };
}

function forceStrangerAccountSignals(account = {}) {
  return {
    ...account,
    isSavedContact: false,
    contactName: null,
    profileName: 'Stranger',
    verifiedBusinessName: null,
    hasVerifiedBusinessIdentity: false,
    hasBusinessProfile: false,
    businessCategory: null,
    businessWebsite: [],
    businessEmail: null,
    identityLevel: 'unknown_sender',
    forcedStranger: true,
    lookupNote: 'Forced stranger mode is enabled for testing.',
  };
}

function skippedAnalysis(reason, recommendation) {
  return {
    score: null,
    level: 'not_reviewed',
    source: 'message-filter',
    reasons: [reason],
    recommendation,
  };
}

async function getAccountSignalsSafe(item) {
  try {
    return await Promise.race([
      getAccountSignals(item),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Account signal lookup timed out')), 7000)),
    ]);
  } catch (error) {
    writeLog('warn', 'Account signal lookup timed out; using message metadata fallback', { messageId: item.id, error: error.message });
    return fallbackAccountSignals(item, error.message);
  }
}

function localHeuristic(text, account = {}) {
  const rules = [
    ['Requests a transfer or payment', /(转账|付款|汇款|充值|payment|transfer|send money|bitcoin|usdt)/i, 26],
    ['Requests a code or password', /(验证码|校验码|密码|口令|otp|verification code|passcode|seed phrase)/i, 30],
    ['Creates urgency', /(立即|马上|紧急|最后机会|账户将被冻结|within \d+ minutes|urgent|immediately|suspended)/i, 18],
    ['Impersonates an institution or support agent', /(银行|警察|海关|税务|快递|客服|官方|security team|support|bank|police|customs)/i, 12],
    ['Contains an external link', /(https?:\/\/|www\.)/i, 14],
    ['Promises prizes or unusual returns', /(中奖|返利|高收益|投资机会|guaranteed profit|lottery|prize)/i, 18],
  ];
  let score = 0;
  const reasons = [];
  for (const [reason, pattern, points] of rules) {
    if (pattern.test(text)) {
      score += points;
      reasons.push(reason);
    }
  }
  if (!account.isSavedContact && score >= 12) {
    score += 8;
    reasons.push('Sender is not in saved contacts');
  }
  if (account.isFirstSeenThisRun && score >= 25) {
    score += 6;
    reasons.push('Account is first seen in this run');
  }
  if (/(银行|警察|海关|税务|快递|客服|官方|bank|police|support)/i.test(text) && !account.hasVerifiedBusinessIdentity) {
    score += 12;
    reasons.push('Claims to be an institution without a verified WhatsApp business identity');
  }
  score = Math.min(99, score);
  return {
    score,
    level: score >= 80 ? 'critical' : score >= 55 ? 'high' : score >= 25 ? 'suspicious' : 'safe',
    reasons: reasons.length ? reasons : ['No obvious scam signals found'],
    source: 'local-heuristic',
    recommendation: score >= 55 ? 'Do not click links, share codes, or transfer money. Verify through an official channel.' : 'Stay cautious and verify payment or identity requests through an official channel.',
    confidence: 0.55,
  };
}

function extractJevAnswer(result, key) {
  const answer = result?.answers?.[key] || result?.data?.answers?.[key] || {};
  return answer && typeof answer === 'object' ? answer : {};
}

function numberFrom(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const match = value.match(/\d+(?:\.\d+)?/);
    if (match) return Number(match[0]);
  }
  return null;
}

function parseJevResult(result, text) {
  const scam = extractJevAnswer(result, 'is_scam');
  const risk = extractJevAnswer(result, 'risk');
  const accountTrust = extractJevAnswer(result, 'account_trust');
  const scoreRaw = numberFrom(scam.noul ?? scam.probability ?? risk.probability ?? result?.risk_score);
  const score = scoreRaw == null ? null : Math.round(Math.max(0, Math.min(1, scoreRaw > 1 ? scoreRaw / 100 : scoreRaw)) * 100);
  const choice = String(scam.choice || scam.selected || risk.choice || '').toLowerCase();
  const inferred = choice.includes('true') || choice.includes('scam') || choice.includes('诈骗') || choice.includes('fraud');
  const finalScore = score ?? (inferred ? 85 : null);
  const reasons = scam.reasons || scam.evidence || risk.reasons || result?.reasons;
  return {
    score: finalScore,
    level: finalScore == null ? 'unknown' : finalScore >= 80 ? 'critical' : finalScore >= 55 ? 'high' : finalScore >= 25 ? 'suspicious' : 'safe',
    reasons: Array.isArray(reasons) ? reasons.map(String).slice(0, 6) : [scam.explanation || risk.explanation || 'Jev completed the decision; review the available evidence.'],
    source: 'jev-latest',
    recommendation: finalScore != null && finalScore >= 55 ? 'Do not click links, share codes, or transfer money. Verify through an official channel.' : 'Stay cautious and verify payment or identity requests through an official channel.',
    raw: result,
    accountDecision: accountTrust.choice || accountTrust.selected || null,
    inputPreview: text.slice(0, 120),
  };
}

function conversationFor(jid) {
  return state.conversations.get(jid) || [];
}

function rememberConversation(item) {
  const turns = conversationFor(item.remoteJid);
  turns.push({
    turn: turns.length + 1,
    id: item.id,
    timestamp: item.timestamp,
    sender: item.sender,
    direction: item.direction,
    text: item.text.slice(0, 2000),
    account: item.account || null,
  });
  const trimmed = turns.slice(-MAX_TURNS_PER_CHAT);
  state.conversations.set(item.remoteJid, trimmed);
  return trimmed;
}

function parseJsonObject(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

function extractOpenAIText(result) {
  if (typeof result?.output_text === 'string') return result.output_text;
  const chunks = [];
  for (const item of result?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === 'string') chunks.push(content.text);
    }
  }
  return chunks.join('\n');
}

function openAIResponsesUrl() {
  const configured = (process.env.OPENAI_API_URL || 'https://api.openai.com/v1/responses').replace(/\/+$/, '');
  if (configured.endsWith('/responses')) return configured;
  if (configured.endsWith('/v1')) return `${configured}/responses`;
  return `${configured}/v1/responses`;
}

async function translateToEnglish(text) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured');
  }
  const payload = {
    model: process.env.OPENAI_MODEL || 'gpt-5.6-luna',
    input: [
      { role: 'system', content: 'Translate the user message into natural English. Return only the translation, with no commentary. Preserve names, URLs, numbers, emojis, and line breaks.' },
      { role: 'user', content: text.slice(0, 12000) },
    ],
    max_output_tokens: 1200,
  };
  const response = await fetch(openAIResponsesUrl(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`OpenAI translation ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const translated = extractOpenAIText(await response.json()).trim();
  if (!translated) throw new Error('OpenAI returned an empty translation');
  return translated;
}

function parseOpenAIResult(result, turns) {
  const parsed = parseJsonObject(extractOpenAIText(result)) || {};
  const scoreRaw = numberFrom(parsed.score ?? parsed.risk_score ?? parsed.scam_probability);
  const score = scoreRaw == null ? null : Math.round(Math.max(0, Math.min(1, scoreRaw > 1 ? scoreRaw / 100 : scoreRaw)) * 100);
  const firstTurn = Number(parsed.first_scam_turn ?? parsed.firstRiskTurn ?? 0) || null;
  return {
    score,
    level: score == null ? 'unknown' : score >= 80 ? 'critical' : score >= 55 ? 'high' : score >= 25 ? 'suspicious' : 'safe',
    confidence: numberFrom(parsed.confidence),
    reasons: Array.isArray(parsed.reasons) ? parsed.reasons.map(String).slice(0, 8) : ['GPT comparison did not return structured reasons'],
    recommendation: String(parsed.recommendation || 'Verify through an official channel before taking action.'),
    firstScamTurn: firstTurn,
    firstScamMessageId: firstTurn ? turns.find((turn) => turn.turn === firstTurn)?.id || null : null,
    turningPoint: String(parsed.turning_point || parsed.turningPoint || ''),
    source: process.env.OPENAI_MODEL || 'gpt-5.6-luna',
    raw: parsed,
  };
}

async function classifyWithOpenAI(text, account, turns) {
  if (!process.env.OPENAI_API_KEY) return { score: null, level: 'unavailable', source: 'openai-not-configured', reasons: ['OPENAI_API_KEY is not configured'], firstScamTurn: null, firstScamMessageId: null, turningPoint: '' };
  const payload = {
    model: process.env.OPENAI_MODEL || 'gpt-5.6-luna',
    input: [
      { role: 'system', content: 'You are an independent WhatsApp scam-risk reviewer. Return JSON only. Assess the full conversation, account signals, and the first turn where scam evidence becomes material. A saved contact or business profile is not proof of safety.' },
      { role: 'user', content: JSON.stringify({ task: 'Score this WhatsApp conversation from 0 to 100 and compare with the current message.', account, currentMessage: text, turns, output: { score: 'number 0-100', confidence: 'number 0-1', reasons: 'string[]', recommendation: 'string', first_scam_turn: 'integer or null', turning_point: 'string' } }) },
    ],
    max_output_tokens: 700,
  };
  const response = await fetch(openAIResponsesUrl(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`OpenAI API ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return parseOpenAIResult(await response.json(), turns);
}

async function classifyWithJev(text, sender, chat, account) {
  if (!process.env.TYPESAFE_API_KEY) return localHeuristic(text, account);
  const payload = {
    model: normaliseJevModel(process.env.TYPESAFE_MODEL),
    state: { channel: 'WhatsApp', sender, chat, message: text, account },
    questions: {
      is_scam: {
        type: 'noul',
        instructions: 'Assess whether this WhatsApp message is likely to be a scam. Consider impersonation, urgency, payments, codes, suspicious links, and unusual promises.',
        criteria: {
          true: 'The message contains material scam or social-engineering risk; the user should stop and verify.',
          false: 'There is not enough evidence of a scam and the message is consistent with normal communication.',
        },
      },
      risk: {
        type: 'choice',
        instructions: 'Choose the message risk level and provide concise, explainable evidence.',
        criteria: {
          safe: 'No obvious risk signals.',
          suspicious: 'Some suspicious signals exist, but evidence is insufficient to call it a scam.',
          high: 'Multiple scam signals exist; stop interacting until verified.',
          critical: 'Highly likely scam involving payment, codes, account takeover, or malicious links.',
        },
      },
      account_trust: {
        type: 'choice',
        instructions: 'Assess account trust using the account signals. A saved contact or business profile is evidence, not proof of safety; raise caution when an official identity is not verified.',
        criteria: {
          trusted_known: 'Saved contact with no material identity conflict.',
          verified_business: 'Message is associated with a WhatsApp verified business name.',
          unknown: 'Unknown sender or insufficient profile data.',
          suspicious_identity: 'The account claims to be an institution but identity, contact, or business data does not match.',
        },
      },
    },
  };
  const response = await fetch(process.env.JEV_API_URL || 'https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Jev API ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return parseJevResult(await response.json(), text);
}

async function analyseMessage(item) {
  item.status = 'analyzing';
  writeLog('info', 'Started message analysis', { messageId: item.id, chat: item.chat, kind: item.kind, textLength: item.text.length });
  broadcastMessage(item);
  let jevCompleted = false;
  try {
    item.account = await getAccountSignalsSafe(item);
    if (item.forcedStranger) item.account = forceStrangerAccountSignals(item.account);
    if (state.reviewUnknownOnly && item.account.isSavedContact) {
      item.status = 'skipped';
      item.analysis = skippedAnalysis('Saved contact; automatic review is disabled by the current setting.', 'No model was called. Disable “Review strangers only” to review all incoming messages.');
      item.comparison = null;
      writeLog('info', 'Skipped saved-contact message', { messageId: item.id, chat: item.chat });
      broadcastMessage(item);
      return;
    }
    const turns = rememberConversation(item);
    broadcastMessage(item);
    writeLog('info', 'Account signals collected', { messageId: item.id, identityLevel: item.account.identityLevel, savedContact: item.account.isSavedContact, verifiedBusiness: item.account.hasVerifiedBusinessIdentity, conversationTurns: turns.length });
    item.analysis = await classifyWithJev(item.text, item.sender, item.chat, item.account);
    jevCompleted = true;
    item.comparison = {
      score: null,
      level: 'pending',
      source: process.env.OPENAI_MODEL || 'gpt-5.6-luna',
      reasons: ['GPT comparison is running…'],
      firstScamTurn: null,
      firstScamMessageId: null,
      turningPoint: '',
    };
    // Publish Jev's decision immediately; GPT may use a slower endpoint.
    broadcastMessage(item);
    try {
      item.comparison = await classifyWithOpenAI(item.text, item.account, turns);
    } catch (error) {
      item.comparison = { score: null, level: 'error', source: 'openai-not-run', reasons: [error.message], firstScamTurn: null, firstScamMessageId: null, turningPoint: '', error: error.message };
      item.status = 'done';
      writeLog('error', 'GPT comparison failed; preserving Jev result', { messageId: item.id, chat: item.chat, jevScore: item.analysis.score, error: error.message });
      broadcastMessage(item);
      if (item.analysis.level === 'critical' || item.analysis.level === 'high') broadcast('warning', item);
      return;
    }
    item.status = 'done';
    writeLog('info', 'Message analysis completed', { messageId: item.id, chat: item.chat, jevSource: item.analysis.source, jevLevel: item.analysis.level, jevScore: item.analysis.score, openaiLevel: item.comparison.level, openaiScore: item.comparison.score, firstScamTurn: item.comparison.firstScamTurn });
  } catch (error) {
    item.status = 'error';
    if (!jevCompleted || !item.analysis) {
      item.analysis = { ...localHeuristic(item.text, item.account), source: 'fallback-after-jev-error', error: error.message };
      item.comparison = { score: null, level: 'error', source: 'openai-not-run', reasons: [error.message], firstScamTurn: null, firstScamMessageId: null, turningPoint: '', error: error.message };
      writeLog('error', 'Jev analysis failed; using local fallback', { messageId: item.id, chat: item.chat, error: error.message });
    } else {
      writeLog('error', 'Message finalization failed after Jev; preserving Jev result', { messageId: item.id, chat: item.chat, jevScore: item.analysis.score, error: error.message });
    }
  }
  broadcastMessage(item);
  if (item.analysis.level === 'critical' || item.analysis.level === 'high') broadcast('warning', item);
}

async function retryGptEvaluation(item) {
  if (!item.account) item.account = await getAccountSignalsSafe(item);
  let turns = conversationFor(item.remoteJid);
  if (!turns.some((turn) => turn.id === item.id)) turns = rememberConversation(item);
  item.comparison = {
    score: null,
    level: 'pending',
    source: process.env.OPENAI_MODEL || 'gpt-5.6-luna',
    reasons: ['Retrying GPT evaluation…'],
    firstScamTurn: null,
    firstScamMessageId: null,
    turningPoint: '',
  };
  broadcastMessage(item);
  writeLog('info', 'Retrying GPT evaluation', { messageId: item.id, chat: item.chat, conversationTurns: turns.length });
  try {
    item.comparison = await classifyWithOpenAI(item.text, item.account, turns);
    if (item.status === 'error') item.status = 'done';
    writeLog('info', 'GPT retry completed', { messageId: item.id, chat: item.chat, openaiLevel: item.comparison.level, openaiScore: item.comparison.score, firstScamTurn: item.comparison.firstScamTurn });
  } catch (error) {
    item.comparison = {
      score: null,
      level: 'error',
      source: 'openai-retry-failed',
      reasons: [error.message],
      firstScamTurn: null,
      firstScamMessageId: null,
      turningPoint: '',
      error: error.message,
    };
    writeLog('error', 'GPT retry failed', { messageId: item.id, chat: item.chat, error: error.message });
  }
  broadcastMessage(item);
  return item.comparison;
}

function addMessage(message) {
  const key = message.key?.id;
  if (!key || state.messages.some((item) => item.id === key)) return;
  const remoteJid = message.key.remoteJid || '';
  const text = normaliseText(message);
  const forcedStranger = state.forceStrangerMode;
  const isOutgoing = message.key.fromMe && !forcedStranger;
  if (!text && messageKind(message) === 'text') return;
  const item = {
    id: key,
    timestamp: Number(message.messageTimestamp || Math.floor(Date.now() / 1000)) * 1000,
    chat: forcedStranger ? 'Stranger' : jidToLabel(remoteJid),
    sender: forcedStranger ? 'Stranger' : jidToLabel(message.key.participant || remoteJid),
    senderJid: message.key.participant || remoteJid,
    pushName: forcedStranger ? 'Stranger' : message.pushName || null,
    verifiedBizName: forcedStranger ? null : message.verifiedBizName || null,
    remoteJid,
    direction: isOutgoing ? 'outgoing' : 'incoming',
    forcedStranger,
    kind: messageKind(message),
    text: text || `[${messageKind(message)} message; only text/caption can be analyzed]`,
    status: 'queued',
    analysis: null,
    account: null,
    translation: null,
  };
  const knownContact = contactForJid(item.senderJid);
  if (isOutgoing && !state.reviewOutgoing) {
    item.status = 'skipped';
    item.account = fallbackAccountSignals(item, 'Outgoing message');
    item.account.identityLevel = 'self';
    item.analysis = skippedAnalysis('Outgoing message review is disabled.', 'No model was called. Enable “Review outgoing messages” in Settings to analyze your own messages.');
  } else if (!forcedStranger && !isOutgoing && state.reviewUnknownOnly && knownContact?.name) {
    item.status = 'skipped';
    item.account = { ...fallbackAccountSignals(item, 'Saved contact'), isSavedContact: true, contactName: knownContact.name, identityLevel: 'saved_contact' };
    item.analysis = skippedAnalysis('Sender is a saved contact and stranger-only review is enabled.', 'No model was called. Disable “Review strangers only” to review saved contacts.');
  } else if (!text) {
    item.status = 'skipped';
    item.account = fallbackAccountSignals(item, 'No text or caption');
    item.analysis = skippedAnalysis(`No text or caption was available for this ${item.kind} message.`, 'No model was called because Jev and GPT can only review text or captions.');
  }
  state.messages.unshift(item);
  state.messages = state.messages.slice(0, MAX_MESSAGES);
  writeLog('info', 'Received new message', { messageId: item.id, chat: item.chat, sender: item.sender, direction: item.direction, kind: item.kind, textLength: item.text.length });
  if (item.status === 'skipped') {
    if (isOutgoing && text) {
      const turns = rememberConversation(item);
      writeLog('info', 'Stored outgoing conversation turn without analysis', { messageId: item.id, chat: item.chat, conversationTurns: turns.length });
    }
    broadcastMessage(item);
  } else if (text) {
    broadcastMessage(item);
    void analyseMessage(item);
  } else {
    const turns = rememberConversation(item);
    writeLog('info', 'Stored outgoing conversation turn', { messageId: item.id, chat: item.chat, conversationTurns: turns.length });
  }
}

async function startWhatsApp() {
  if (state.socket || state.connection === 'connecting') return;
  writeLog('info', 'Starting WhatsApp connection');
  state.stopping = false;
  await fs.mkdir(AUTH_DIR, { recursive: true });
  setConnection('connecting');
  const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  try {
    await fetch(WHATSAPP_PREFLIGHT_URL, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
  } catch (error) {
    writeLog('warn', 'WhatsApp network preflight failed; QR may not be available until network access is restored', { url: WHATSAPP_PREFLIGHT_URL, error: error.message });
  }
  let version;
  try {
    const latest = await Promise.race([
      fetchLatestBaileysVersion(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Baileys version lookup timed out')), 10000)),
    ]);
    ({ version } = latest || {});
  } catch (error) {
    writeLog('warn', 'Baileys version lookup failed; using library default', { error: error.message });
    version = undefined;
  }
  const socket = makeWASocket({
    auth: authState,
    version,
    browser: Browsers.macOS('Jev Guard'),
    logger,
    ...(process.env.WHATSAPP_PROXY_URL ? { agent: new HttpsProxyAgent(process.env.WHATSAPP_PROXY_URL) } : {}),
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: true,
  });
  writeLog('info', 'Baileys socket created', { proxyConfigured: Boolean(process.env.WHATSAPP_PROXY_URL), version: version || 'library-default' });
  state.socket = socket;
  socket.ev.on('creds.update', async (update) => {
    await saveCreds(update);
    if (update?.me) updateCurrentAccount(update.me);
  });
  socket.ev.on('contacts.upsert', (contacts) => {
    rememberContacts(contacts);
    const ownId = socket.user?.id;
    const ownContact = contacts.find((contact) => contact?.id === ownId || contact?.jid === ownId || contact?.lid === ownId);
    if (ownContact) updateCurrentAccount(ownContact);
    writeLog('info', 'Contact records synchronized', { count: contacts.length });
  });
  socket.ev.on('contacts.update', (contacts) => {
    rememberContacts(contacts);
    const ownId = socket.user?.id;
    const ownContact = contacts.find((contact) => contact?.id === ownId || contact?.jid === ownId || contact?.lid === ownId);
    if (ownContact) updateCurrentAccount(ownContact);
  });
  socket.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      state.qr = await QRCode.toDataURL(qr, { width: 280, margin: 2 });
      writeLog('info', 'WhatsApp login QR generated');
      setConnection('qr', { qr: state.qr });
    }
    if (connection === 'open') {
      state.qr = null;
      state.reconnectAttempts = 0;
      state.reauthRequired = false;
      state.connectionError = null;
      state.user = socket.user ? accountUser(socket.user) : null;
      writeLog('info', 'WhatsApp connection opened', { user: state.user?.name || null });
      setConnection('connected', { qr: null, user: state.user });
    }
    if (connection === 'close') {
      state.socket = null;
      state.qr = null;
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      const timedOut = code === 408;
      const canReconnect = !loggedOut && !state.stopping;
      state.reauthRequired = loggedOut;
      if (loggedOut) {
        state.connectionError = 'Login session expired. Clear the session and scan again.';
        state.reconnectAttempts = 0;
      } else if (timedOut && canReconnect) {
        state.reconnectAttempts += 1;
        if (state.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
          state.reauthRequired = true;
          state.connectionError = `WhatsApp initialization timed out after ${MAX_RECONNECT_ATTEMPTS} attempts. Clear the session and scan again.`;
          state.reconnectAttempts = 0;
        } else {
          const delay = Math.min(60000, 3000 * 2 ** (state.reconnectAttempts - 1));
          state.connectionError = `Initialization timed out; retrying in ${Math.ceil(delay / 1000)} seconds (${state.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}).`;
          writeLog('warn', 'WhatsApp initialization timed out; scheduling retry', { code, attempt: state.reconnectAttempts, maxAttempts: MAX_RECONNECT_ATTEMPTS, delayMs: delay });
          setConnection('reconnecting');
          if (!state.reconnectTimer) {
            state.reconnectTimer = setTimeout(() => { state.reconnectTimer = null; void startWhatsApp(); }, delay);
          }
          return;
        }
      } else {
        state.reconnectAttempts = 0;
        state.connectionError = canReconnect ? `WhatsApp connection closed (${code || 'unknown'}). Retrying.` : null;
      }
      const shouldReconnect = canReconnect && !timedOut && !state.reauthRequired;
      writeLog(shouldReconnect ? 'warn' : 'error', 'WhatsApp connection closed', { code, reconnect: shouldReconnect, reauthRequired: state.reauthRequired });
      setConnection(shouldReconnect ? 'reconnecting' : 'disconnected');
      if (shouldReconnect && !state.reconnectTimer) {
        state.reconnectTimer = setTimeout(() => { state.reconnectTimer = null; void startWhatsApp(); }, 5000);
      }
    }
  });
  socket.ev.on('messages.upsert', ({ messages, type }) => {
    const batch = Array.isArray(messages) ? messages : [];
    writeLog('info', 'WhatsApp messages.upsert received', {
      type,
      count: batch.length,
      fromMe: batch.filter((message) => Boolean(message.key?.fromMe)).length,
    });
    // notify is a live event. append is used for messages delivered while this
    // linked device was offline; keep recent append events so they are not lost.
    const now = Date.now();
    for (const message of batch) {
      if (type === 'notify') {
        addMessage(message);
        continue;
      }
      if (type === 'append') {
        const rawTimestamp = Number(message.messageTimestamp || 0);
        const timestampMs = rawTimestamp > 1e12 ? rawTimestamp : rawTimestamp * 1000;
        const isRecent = !timestampMs || now - timestampMs <= 24 * 60 * 60 * 1000;
        if (isRecent) addMessage(message);
      }
    }
  });
}

async function stopWhatsApp() {
  state.stopping = true;
  writeLog('info', 'Stopping WhatsApp connection');
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  state.reconnectAttempts = 0;
  try { state.socket?.end(undefined); } catch {}
  state.socket = null;
  state.qr = null;
  state.user = null;
  setConnection('disconnected', { qr: null, user: null });
}

async function resetAuthState() {
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  await fs.rm(AUTH_DIR, { recursive: true, force: true });
  state.reauthRequired = false;
  state.connectionError = null;
  state.reconnectAttempts = 0;
  writeLog('warn', 'Cleared invalid WhatsApp auth state');
}

app.get('/api/state', (_req, res) => res.json(publicState()));
app.get('/api/settings', (_req, res) => res.json(publicSettings()));
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  state.clients.add(res);
  res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
  req.on('close', () => state.clients.delete(res));
});
app.post('/api/connect', async (_req, res) => {
  writeLog('info', 'Received connect request');
  if (state.reauthRequired) await resetAuthState();
  await startWhatsApp();
  res.json({ ok: true });
});
app.post('/api/disconnect', async (_req, res) => {
  writeLog('info', 'Received disconnect request');
  await stopWhatsApp();
  res.json({ ok: true });
});
app.post('/api/settings', (req, res) => {
  const { apiKey, model, apiUrl, openaiApiKey, openaiModel, openaiApiUrl, whatsappProxyUrl, reviewUnknownOnly, reviewOutgoing, forceStrangerMode } = req.body || {};
  if (typeof apiKey === 'string' && apiKey.trim()) process.env.TYPESAFE_API_KEY = apiKey.trim();
  if (typeof model === 'string' && model.trim()) process.env.TYPESAFE_MODEL = normaliseJevModel(model);
  if (typeof apiUrl === 'string' && apiUrl.trim()) process.env.JEV_API_URL = apiUrl.trim();
  if (typeof openaiApiKey === 'string' && openaiApiKey.trim()) process.env.OPENAI_API_KEY = openaiApiKey.trim();
  if (typeof openaiModel === 'string' && openaiModel.trim()) process.env.OPENAI_MODEL = openaiModel.trim();
  if (typeof openaiApiUrl === 'string' && openaiApiUrl.trim()) process.env.OPENAI_API_URL = openaiApiUrl.trim();
  if (typeof whatsappProxyUrl === 'string' && whatsappProxyUrl.trim()) process.env.WHATSAPP_PROXY_URL = whatsappProxyUrl.trim();
  if (typeof reviewUnknownOnly === 'boolean') state.reviewUnknownOnly = reviewUnknownOnly;
  if (typeof reviewOutgoing === 'boolean') state.reviewOutgoing = reviewOutgoing;
  if (typeof forceStrangerMode === 'boolean') state.forceStrangerMode = forceStrangerMode;
  saveSettings();
  writeLog('info', 'Jev settings updated', { configured: Boolean(process.env.TYPESAFE_API_KEY), model: normaliseJevModel(process.env.TYPESAFE_MODEL) });
  broadcast('state', publicState());
  res.json({ ok: true, jevConfigured: Boolean(process.env.TYPESAFE_API_KEY), openaiConfigured: Boolean(process.env.OPENAI_API_KEY) });
});
app.post('/api/messages/:id/translate', async (req, res) => {
  const item = state.messages.find((message) => message.id === req.params.id);
  if (!item) return res.status(404).json({ ok: false, error: 'Message not found' });
  if (item.translation?.text) return res.json({ ok: true, translation: item.translation });
  try {
    writeLog('info', 'Starting English translation', { messageId: item.id, chat: item.chat, textLength: item.text.length });
    const text = await translateToEnglish(item.text);
    item.translation = { text, model: process.env.OPENAI_MODEL || 'gpt-5.6-luna', translatedAt: new Date().toISOString() };
    broadcastMessage(item);
    writeLog('info', 'English translation completed', { messageId: item.id, model: item.translation.model });
    return res.json({ ok: true, translation: item.translation });
  } catch (error) {
    writeLog('error', 'English translation failed', { messageId: item.id, error: error.message });
    return res.status(502).json({ ok: false, error: error.message });
  }
});
app.post('/api/messages/:id/retry-gpt', async (req, res) => {
  const item = state.messages.find((message) => message.id === req.params.id);
  if (!item) return res.status(404).json({ ok: false, error: 'Message not found' });
  if (item.status === 'skipped') return res.status(400).json({ ok: false, error: 'GPT review was skipped by the current settings' });
  try {
    const comparison = await retryGptEvaluation(item);
    return res.json({ ok: true, comparison });
  } catch (error) {
    writeLog('error', 'GPT retry request failed', { messageId: item.id, error: error.message });
    return res.status(502).json({ ok: false, error: error.message });
  }
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
const httpServer = app.listen(PORT, () => {
  console.log(`Jev Guard running at http://localhost:${PORT}`);
  console.log('Read-only mode: it never sends, deletes, or modifies WhatsApp messages.');
  writeLog('info', 'Jev Guard started', { port: PORT, logFile: LOG_FILE, jevConfigured: Boolean(process.env.TYPESAFE_API_KEY), openaiConfigured: Boolean(process.env.OPENAI_API_KEY) });
  setTimeout(() => openBrowser(`http://localhost:${PORT}`), 250);
});
httpServer.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. An existing Jev Guard instance may be running, or use PORT=8788 npm start.`);
    process.exitCode = 1;
    return;
  }
  console.error('Local service failed to start:', error);
  process.exitCode = 1;
});

process.on('SIGINT', async () => { await stopWhatsApp(); process.exit(0); });
process.on('SIGTERM', async () => { await stopWhatsApp(); process.exit(0); });
