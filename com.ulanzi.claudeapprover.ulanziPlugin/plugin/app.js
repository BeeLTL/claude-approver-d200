import UlanziApi from './plugin-common-node/index.js';
import { HookServer } from './lib/hook-server.js';
import {
  renderApprove,
  renderAlways,
  renderDeny,
  renderNext,
  renderSession,
} from './lib/render.js';

const PLUGIN_UUID = 'com.ulanzi.ulanzistudio.claudeapprover';
const ACTION_APPROVE = `${PLUGIN_UUID}.approve`;
const ACTION_ALWAYS = `${PLUGIN_UUID}.always`;
const ACTION_DENY = `${PLUGIN_UUID}.deny`;
const ACTION_NEXT = `${PLUGIN_UUID}.next`;
const ACTION_SESSION = `${PLUGIN_UUID}.session`;

const DEFAULTS = {
  port: 9247,
  holdSeconds: 110,
  onTimeout: 'ask',
  cwdFilter: '',
  token: '',
};

const TICK_MS = 500; // drives both the countdown and the flash

const $UD = new UlanziApi();
const server = new HookServer();
const KEYS = new Map(); // context -> { uuid, settings }
const PAINTED = new Map(); // context -> last data url, so we only send changes
let config = { ...DEFAULTS };
let ticker = null;
let flashOn = true;

function log(...args) {
  console.log('[claude-approver]', ...args);
}

function actionOf(context) {
  return ($UD.decodeContext(context) || {}).uuid || '';
}

// Diagnostic: record exactly what UlanziStudio sends for a key, so the action
// a press belongs to can be identified from evidence rather than assumption.
// Surfaced on GET /hook.
function trace(event, jsn) {
  const context = jsn && jsn.context;
  server.diag.unshift({
    at: new Date().toISOString().slice(11, 19),
    event,
    context: context || null,
    decoded: context ? $UD.decodeContext(context) : null,
    msgUuid: jsn && jsn.uuid,
    msgKey: jsn && jsn.key,
    msgActionId: jsn && jsn.actionid,
    resolved: context ? actionOf(context) : null,
  });
  server.diag.length = Math.min(server.diag.length, 10);
}

// The last path segment is what actually identifies a project on a key.
function projectName(cwd) {
  if (!cwd) return '';
  return String(cwd).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
}

// One line of "what is Claude actually asking to do", per tool.
function detailOf(entry) {
  const input = entry.input || {};
  if (typeof input.command === 'string') return input.command;
  if (typeof input.file_path === 'string') return projectName(input.file_path);
  if (typeof input.url === 'string') return input.url;
  if (typeof input.pattern === 'string') return input.pattern;
  const first = Object.values(input).find((v) => typeof v === 'string');
  return first || '';
}

function approvalView() {
  const entry = server.current;
  const count = server.queue.length;
  if (!entry) return { pending: false, count, listening: server.listening };
  return {
    pending: true,
    count,
    listening: server.listening,
    tool: entry.tool,
    rule: server.pendingRule(),
    detail: detailOf(entry),
    project: projectName(entry.cwd),
    position: server.cursor + 1,
    secondsLeft: Math.max(0, Math.round((entry.expiresAt - Date.now()) / 1000)),
  };
}

// Session keys claim slots in the order they were dropped onto the deck, so
// however many you add is how many sessions you watch. A key with a project
// name in its settings pins itself to that project instead.
function sessionSlots() {
  const slots = new Map();
  let index = 0;
  for (const [context, key] of KEYS) {
    if (key.uuid !== ACTION_SESSION) continue;
    slots.set(context, index);
    index++;
  }
  return slots;
}

function sessionFor(context, slot, ordered) {
  const pin = (KEYS.get(context)?.settings?.project || '').trim();
  if (pin) return server.sessions.find(pin);
  return ordered[slot] || null;
}

function paint(context, uuid, view, slots, ordered, pendingBySession) {
  let data;
  if (uuid === ACTION_APPROVE) data = renderApprove(view);
  else if (uuid === ACTION_ALWAYS) data = renderAlways(view);
  else if (uuid === ACTION_DENY) data = renderDeny(view);
  else if (uuid === ACTION_NEXT) data = renderNext(view);
  else if (uuid === ACTION_SESSION) {
    const slot = slots.get(context) || 0;
    const session = sessionFor(context, slot, ordered);
    data = renderSession({
      session,
      slot,
      flashOn,
      pending: session ? pendingBySession.get(session.id) : null,
    });
  } else return;

  // The websocket carries a full image per update; skipping identical frames
  // keeps a five-key layout from repainting 10 times a second for nothing.
  if (PAINTED.get(context) === data) return;
  PAINTED.set(context, data);
  $UD.setBaseDataIcon(context, data);
}

function repaint() {
  server.sessions.sweep();
  const view = approvalView();
  const slots = sessionSlots();
  const ordered = server.sessions.ordered();

  // First request per session wins the key; the rest are reachable with Next.
  const pendingBySession = new Map();
  for (const entry of server.queue) {
    if (pendingBySession.has(entry.session)) continue;
    pendingBySession.set(entry.session, {
      tool: entry.tool,
      detail: detailOf(entry),
      secondsLeft: Math.max(0, Math.round((entry.expiresAt - Date.now()) / 1000)),
    });
  }

  for (const [context, key] of KEYS) paint(context, key.uuid, view, slots, ordered, pendingBySession);

  // Tick while anything is counting down or asking to be noticed.
  const needsTick =
    view.pending ||
    ordered.some((s) => s.state === 'approval' || s.state === 'input');
  if (needsTick && !ticker) {
    ticker = setInterval(() => {
      flashOn = !flashOn;
      repaint();
    }, TICK_MS);
  } else if (!needsTick && ticker) {
    clearInterval(ticker);
    ticker = null;
    flashOn = true;
  }
}

function applySettings(settings) {
  if (!settings || typeof settings !== 'object') return;
  const next = { ...config };
  const port = parseInt(settings.port, 10);
  if (port >= 1024 && port <= 65535) next.port = port;
  const hold = parseInt(settings.holdSeconds, 10);
  if (hold >= 5 && hold <= 3600) next.holdSeconds = hold;
  if (settings.onTimeout === 'ask' || settings.onTimeout === 'deny') next.onTimeout = settings.onTimeout;
  if (typeof settings.cwdFilter === 'string') next.cwdFilter = settings.cwdFilter;
  if (typeof settings.token === 'string') next.token = settings.token;

  const portChanged = next.port !== config.port;
  config = next;
  server.configure(config);
  if (portChanged || !server.listening) server.start(config.port, config);
  repaint();
}

server.on('change', repaint);
server.on('log', (msg) => log(msg));

// The hook endpoint comes up whether or not UlanziStudio is talking to us, so a
// dropped websocket never leaves Claude Code posting into a closed port.
server.start(config.port, config);

$UD.connect(PLUGIN_UUID);

$UD.onConnected(() => {
  log('connected to UlanziStudio');
  repaint();
});

$UD.onAdd((jsn) => {
  const context = jsn.context;
  trace('add', jsn);
  if (!context) return;
  KEYS.set(context, { uuid: actionOf(context), settings: jsn.param || {} });
  applySettings(jsn.param);
  repaint();
});

$UD.onParamFromApp((jsn) => {
  const key = KEYS.get(jsn.context);
  if (key) key.settings = jsn.param || {};
  applySettings(jsn.param);
});

$UD.onParamFromPlugin((jsn) => {
  const key = KEYS.get(jsn.context);
  if (key) key.settings = jsn.param || {};
  applySettings(jsn.param);
  if (jsn.context) $UD.setSettings(jsn.param || {}, jsn.context);
});

$UD.onClear((jsn) => {
  if (!jsn.param) return;
  for (const item of jsn.param) {
    KEYS.delete(item.context);
    PAINTED.delete(item.context);
  }
});

$UD.onRun((jsn) => {
  const context = jsn.context;
  const uuid = actionOf(context);
  trace('run', jsn);

  if (uuid === ACTION_SESSION) return; // a status key, nothing to press

  if (uuid === ACTION_NEXT) {
    server.next();
    return;
  }

  const decision = uuid === ACTION_DENY ? 'deny' : 'allow';
  const always = uuid === ACTION_ALWAYS;
  const result = server.decide(decision, { always });
  if (!result) {
    $UD.showAlert(context);
    $UD.toast('No Claude Code request is waiting');
    return;
  }
  const { entry, rule } = result;
  log(`${always ? 'always-' : ''}${decision} ${entry.tool} (${entry.cwd})`);
  $UD.toast(
    rule
      ? `Allowing ${rule.label} for this session`
      : `${decision === 'allow' ? 'Approved' : 'Denied'} ${entry.tool}`
  );
});

process.on('uncaughtException', (err) => log('uncaught:', err && err.stack ? err.stack : err));
process.on('unhandledRejection', (err) => log('unhandled:', err));
