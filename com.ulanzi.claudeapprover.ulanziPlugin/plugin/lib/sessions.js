import fs from 'fs';

// Hook payloads carry no token accounting, but they do carry transcript_path.
// The transcript's assistant lines each record the usage of that request, and
// input + cache_creation + cache_read is precisely what was in the context
// window for that turn — so the newest assistant line is the live figure.
const TAIL_BYTES = 512 * 1024;
const CONTEXT_TTL_MS = 5000;
const DEFAULT_CONTEXT_WINDOW = 200000;
// Model ids do not announce their context window, so the largest prompt ever
// observed for a model is used as a lower bound and rounded up to the next
// real tier. A 218k turn cannot have come from a 200k window.
//
// Crucially this is tracked per *model*, not per session: inferring it from
// one session's own usage made a quiet 194k session read 97% while a busier
// 227k one read 46%, which is worse than useless on keys meant to be compared
// against each other. One session proving a model reaches 822k settles the
// window for every session on that model.
const WINDOW_TIERS = [200000, 500000, 1000000];
const highWaterByModel = new Map();

// The tiered guess above only ever revises upward from what it has actually
// observed, which is the wrong direction to be wrong in: a session on a model
// it has not seen much traffic from yet starts out assumed to have the
// smallest window, so it reads as nearly full long before it really is.
// Confirmed directly against Claude Code's own context readout while
// claude-sonnet-5 was live in this session: 207k / 1,000,000 = 21%, not the
// ~95%+ the tiered guess gave it moments earlier under the same model. The
// rest of the current generation is assumed to share that window rather than
// each starting the guess over from scratch the moment you switch models --
// unconfirmed for the others, but a shared window per generation is how the
// API has worked historically, and the alternative is the same wrong-direction
// mistake this section exists to fix.
const KNOWN_WINDOWS = [
  [/^claude-opus-5(-|$)/, 1000000],
  [/^claude-sonnet-5(-|$)/, 1000000],
  [/^claude-fable-5-1(-|$)/, 1000000],
  [/^claude-haiku-4-5(-|$)/, 1000000],
];

function explicitWindowFor(model) {
  const id = String(model || '');
  const hit = KNOWN_WINDOWS.find(([pattern]) => pattern.test(id));
  return hit ? hit[1] : null;
}

export function noteUsage(model, used) {
  if (!model || !used) return;
  const seen = highWaterByModel.get(model) || 0;
  if (used > seen) highWaterByModel.set(model, used);
}

// Exposed for tests: what the plugin currently believes about each model.
export function knownWindows() {
  return [...highWaterByModel].map(([model, used]) => [model, contextWindowFor(model, used)]);
}
const IDLE_AFTER_MS = 5 * 60 * 1000;

export const State = Object.freeze({
  WORKING: 'working',
  APPROVAL: 'approval',
  INPUT: 'input',
  DONE: 'done',
  IDLE: 'idle',
});

function contextWindowFor(model, used = 0) {
  const id = String(model || '');
  if (id.includes('[1m]')) return 1000000;
  const known = explicitWindowFor(id);
  if (known) return known;
  const highWater = Math.max(used, highWaterByModel.get(id) || 0);
  const tier = WINDOW_TIERS.find((size) => highWater <= size);
  return tier || WINDOW_TIERS[WINDOW_TIERS.length - 1];
}

// Read only the tail: transcripts run to tens of megabytes on long sessions.
function readTail(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

export function readContextUsage(transcriptPath) {
  if (!transcriptPath) return null;
  let text;
  try {
    text = readTail(transcriptPath);
  } catch {
    return null;
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{') || !line.includes('"usage"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a partial first line from the tail cut, or a mid-write line
    }
    const usage = entry && entry.message && entry.message.usage;
    if (!usage) continue;
    const used =
      (usage.input_tokens || 0) +
      (usage.cache_creation_input_tokens || 0) +
      (usage.cache_read_input_tokens || 0);
    if (!used) continue;
    noteUsage(entry.message.model, used);
    const window = contextWindowFor(entry.message.model, used);
    return {
      used,
      window,
      ratio: Math.min(1, used / window),
      model: entry.message.model,
      // Free of charge: the same line records where the work is happening.
      branch: entry.gitBranch || '',
      effort: entry.effort || '',
    };
  }
  return null;
}

function projectName(cwd) {
  if (!cwd) return '';
  return String(cwd).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
}

export class SessionRegistry {
  constructor() {
    this.sessions = new Map(); // session_id -> record
  }

  touch(hook) {
    const id = hook && hook.session_id;
    if (!id) return null;
    let session = this.sessions.get(id);
    if (!session) {
      session = {
        id,
        firstSeen: Date.now(),
        state: State.IDLE,
        pending: 0,
        rules: 0,
        context: null,
        contextCheckedAt: 0,
      };
      this.sessions.set(id, session);
    }
    if (hook.cwd) {
      session.cwd = hook.cwd;
      session.project = projectName(hook.cwd);
    }
    if (hook.transcript_path) session.transcriptPath = hook.transcript_path;
    session.lastActivity = Date.now();
    this._refreshContext(session);
    return session;
  }

  _refreshContext(session) {
    const now = Date.now();
    if (now - session.contextCheckedAt < CONTEXT_TTL_MS) return;
    session.contextCheckedAt = now;
    const usage = readContextUsage(session.transcriptPath);
    if (usage) session.context = usage;
  }

  setState(id, state) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.state = state;
    session.lastActivity = Date.now();
  }

  remove(id) {
    this.sessions.delete(id);
  }

  // A finished session goes grey once it has been quiet for a while, so a wall
  // of green does not outlive its usefulness.
  sweep() {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (session.state === State.DONE && now - session.lastActivity > IDLE_AFTER_MS) {
        session.state = State.IDLE;
      }
    }
  }

  // Oldest first, so a key keeps showing the same session as others come and go.
  ordered() {
    return [...this.sessions.values()].sort((a, b) => a.firstSeen - b.firstSeen);
  }

  find(project) {
    const needle = String(project || '').trim().toLowerCase();
    if (!needle) return null;
    return (
      this.ordered().find(
        (s) =>
          (s.project || '').toLowerCase() === needle ||
          (s.cwd || '').toLowerCase().includes(needle)
      ) || null
    );
  }
}
