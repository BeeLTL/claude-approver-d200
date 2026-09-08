import UlanziApi from './plugin-common-node/index.js';
import { HookServer } from './lib/hook-server.js';
import {
  renderApprove,
  renderAlways,
  renderDeny,
  renderChoice,
  renderNext,
  renderSession,
  renderUsage,
  renderBoard,
} from './lib/render.js';
import { fetchUsage, formatReset, UsageError } from './lib/usage.js';

const PLUGIN_UUID = 'com.ulanzi.ulanzistudio.claudeapprover';
const ACTION_APPROVE = `${PLUGIN_UUID}.approve`;
const ACTION_ALWAYS = `${PLUGIN_UUID}.always`;
const ACTION_DENY = `${PLUGIN_UUID}.deny`;
const ACTION_NEXT = `${PLUGIN_UUID}.next`;
const ACTION_SESSION = `${PLUGIN_UUID}.session`;
// One action per answer slot; the trailing digit is the option it picks.
const CHOICE_ACTIONS = [1, 2, 3, 4].map((n) => `${PLUGIN_UUID}.choice${n}`);
const ACTION_USAGE = `${PLUGIN_UUID}.usage`;
const ACTION_BOARD = `${PLUGIN_UUID}.board`;

// What the board shows when several sessions are live: whatever most wants a
// human, then whatever is moving, then whatever finished.
const STATE_PRIORITY = { approval: 0, input: 1, working: 2, done: 3, idle: 4 };

const DEFAULTS = {
  port: 9247,
  holdSeconds: 110,
  onTimeout: 'ask',
  cwdFilter: '',
  token: '',
  // Arrows, not digits: the host presses physical keys, so "1" lands as & on
  // AZERTY and as something else again on QWERTZ. Down/Enter are layout-proof.
};

const TICK_MS = 500; // drives both the countdown and the flash
// Usage costs an API round trip, so it is polled slowly and shared by every
// usage key rather than fetched per key.
const USAGE_POLL_MS = 5 * 60 * 1000;
const KEYSTROKE_LEAD_MS = 220; // settle time before the first synthetic key
const KEYSTROKE_GAP_MS = 180; // gap between them, so the host drops none

const $UD = new UlanziApi();
const server = new HookServer();
const KEYS = new Map(); // context -> { uuid, settings }
const PAINTED = new Map(); // context -> last data url, so we only send changes
let config = { ...DEFAULTS };
let ticker = null;
let flashOn = true;
let usage = null; // last successful reading, or the error that replaced it
let usageTimer = null;

function log(...args) {
  console.log('[claude-approver]', ...args);
}

function actionOf(context) {
  return ($UD.decodeContext(context) || {}).uuid || '';
}

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
  if (!entry) return { pending: false, count };
  return {
    pending: true,
    count,
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

// The one session worth a single wide key.
function headlineSession(ordered) {
  if (!ordered.length) return null;
  return [...ordered].sort((a, b) => {
    const byState = (STATE_PRIORITY[a.state] ?? 9) - (STATE_PRIORITY[b.state] ?? 9);
    if (byState) return byState;
    return (b.lastActivity || 0) - (a.lastActivity || 0);
  })[0];
}

function paint(context, uuid, view, slots, ordered, pendingBySession) {
  let data;
  if (uuid === ACTION_APPROVE) data = renderApprove(view);
  else if (uuid === ACTION_ALWAYS) data = renderAlways(view);
  else if (uuid === ACTION_DENY) data = renderDeny(view);
  else if (uuid === ACTION_NEXT) data = renderNext(view);
  else if (uuid === ACTION_BOARD) {
    const pin = (KEYS.get(context)?.settings?.project || '').trim();
    const session = pin ? server.sessions.find(pin) : headlineSession(ordered);
    data = renderBoard({
      session,
      pending: session ? pendingBySession.get(session.id) : null,
      question: server.currentQuestion,
      flashOn,
    });
  }
  else if (uuid === ACTION_USAGE) {
    const metric = (KEYS.get(context)?.settings?.metric === '7d') ? '7d' : '5h';
    data = renderUsage(usageView(metric));
  }
  else if (CHOICE_ACTIONS.includes(uuid)) {
    const index = CHOICE_ACTIONS.indexOf(uuid);
    const current = server.currentQuestion;
    const progress = server.question && server.question.items.length > 1
      ? ` ${server.question.index + 1}/${server.question.items.length}`
      : '';
    data = renderChoice({
      index,
      choice: current ? current.options[index] : null,
      header: current ? current.header + progress : '',
    });
  }
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

// Claude's question picker lives in the terminal, so the only honest way to
// answer it is to press the keys a human would. Two dialects, because which one
// the picker accepts is not documented: a bare option number, or arrow-downs
// followed by Enter.
function answerWithKeystrokes(index) {
  // Always arrows. Sending the option number instead means the host presses the
  // physical key where a digit sits on QWERTY, which on an AZERTY keyboard types
  // & or e-acute into the prompt rather than choosing anything.
  //
  // Each hotkey is a websocket round trip that the host turns into a synthetic
  // key press, and pressing them close together loses some -- measured on an
  // AZERTY D200, 60ms gaps dropped one or both steps at random. These delays
  // are deliberately generous: a quarter-second to answer is imperceptible,
  // whereas landing on the wrong option is not.
  // The first synthetic key is consumed bringing the window forward and never
  // reaches the picker -- measured as a reliable one-row shortfall. So the
  // first key sent is a lone Shift, which moves nothing if it does arrive.
  let step = 0;
  const walk = () => {
    if (step < index) {
      $UD.hotkey('Down');
      step++;
      setTimeout(walk, KEYSTROKE_GAP_MS);
      return;
    }
    setTimeout(() => $UD.hotkey('Enter'), KEYSTROKE_GAP_MS);
  };
  $UD.hotkey('Shift');
  setTimeout(walk, KEYSTROKE_LEAD_MS);
}

async function refreshUsage() {
  const result = await fetchUsage({ configDir: config.configDir });
  usage = result.ok
    ? { ok: true, data: result.data }
    : { ok: false, kind: result.kind, expired: result.expired };
  if (!result.ok) log('usage:', result.kind, result.message);
  repaint();
}

function startUsagePolling() {
  if (usageTimer) return;
  refreshUsage();
  usageTimer = setInterval(refreshUsage, USAGE_POLL_MS);
}

function usageView(metric) {
  if (!usage) return { metric };
  if (!usage.ok) return { metric, error: usage.kind, expired: usage.expired };
  const ratio = metric === '7d' ? usage.data.util7d : usage.data.util5h;
  const reset = metric === '7d' ? usage.data.reset7d : usage.data.reset5h;
  if (ratio === null || ratio === undefined) return { metric, error: UsageError.UNKNOWN };
  return { metric, usage: { ratio, reset: formatReset(reset) } };
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
  if (typeof settings.configDir === 'string') next.configDir = settings.configDir;
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
  if (!context) return;
  KEYS.set(context, { uuid: actionOf(context), settings: jsn.param || {} });
  if (actionOf(context) === ACTION_USAGE) startUsagePolling();
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

  if (uuid === ACTION_SESSION) return; // a status key, nothing to press

  if (uuid === ACTION_USAGE) {
    refreshUsage();
    return;
  }

  if (uuid === ACTION_NEXT) {
    server.next();
    return;
  }

  if (CHOICE_ACTIONS.includes(uuid)) {
    const index = CHOICE_ACTIONS.indexOf(uuid);
    const current = server.currentQuestion;
    const option = current && current.options[index];
    if (!option) {
      $UD.showAlert(context);
      $UD.toast('No question is waiting');
      return;
    }
    const answered = server.answer(index);
    if (!answered) {
      // A question with no MCP call behind it came from Claude Code's own
      // AskUserQuestion, which the deck cannot answer -- fall back to typing.
      answerWithKeystrokes(index);
      $UD.toast(`Answering: ${option.label}`);
      return;
    }
    log(`answered "${answered.label}"${answered.more ? `, ${answered.remaining} to go` : ''}`);
    $UD.toast(
      answered.more
        ? `${answered.label} — ${answered.remaining} more`
        : `Answered: ${answered.label}`
    );
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
