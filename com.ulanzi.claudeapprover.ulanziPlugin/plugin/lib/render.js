// Key icons are SVG documents handed to the deck as base64 data URLs. The host
// rasterises them, so there is no canvas dependency and text stays crisp at the
// 196-200px the D200 keys render at.

const SIZE = 200;
const BG = '#1f1f23';
const BG_HOT = '#22301f';
const BG_COLD = '#17171a';
const TEXT = '#ffffff';
const MUTED = '#8b8b95';
const GREEN = '#3ecf6b';
const RED = '#e3434c';
const AMBER = '#e3b341';
const BLUE = '#4a9eff';
const PURPLE = '#b46ff0';
const GREY = '#4a4a52';
const FONT = '-apple-system,Segoe UI,Helvetica,Arial,sans-serif';

// One colour per session state, matching the words on the key.
const STATE_STYLE = {
  working: { color: BLUE, label: 'Working', flash: false },
  approval: { color: AMBER, label: 'Approve', flash: true },
  input: { color: PURPLE, label: 'Input', flash: true },
  done: { color: GREEN, label: 'Done', flash: false },
  idle: { color: '#6b6b75', label: 'Idle', flash: false },
};

function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Rough width estimate: the host has no text-measuring pass, so clip by
// character count rather than letting a long tool name run off the key.
function clip(s, max) {
  const t = String(s == null ? '' : s);
  return t.length <= max ? t : t.slice(0, Math.max(1, max - 1)) + '…';
}

// Shrink a label to fit the key rather than truncating it: project names are
// the one thing that must stay readable at a glance.
function fitSize(s, maxSize, available = SIZE - 24) {
  const len = Math.max(1, String(s || '').length);
  return Math.max(14, Math.min(maxSize, Math.floor(available / (0.60 * len))));
}

function text(t, x, y, size, { fill = TEXT, weight = '700', anchor = 'middle' } = {}) {
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" fill="${fill}">${escapeXml(t)}</text>`;
}

function doc(body, bg = BG) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}"><rect width="${SIZE}" height="${SIZE}" rx="24" fill="${bg}"/>${body}</svg>`;
}

function toDataUrl(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

// A badge in the top-right corner counting the other requests still queued.
function queueBadge(count) {
  if (!count || count < 2) return '';
  return (
    `<circle cx="${SIZE - 26}" cy="26" r="18" fill="${AMBER}"/>` +
    text(String(count), SIZE - 26, 33, 24, { fill: '#1f1f23', weight: '800' })
  );
}

// Context fill is colour-coded on its own scale: a nearly full window is worth
// noticing regardless of what the session is doing.
function contextColor(ratio) {
  if (ratio >= 0.95) return RED;
  if (ratio >= 0.85) return '#e8893c';
  if (ratio >= 0.6) return AMBER;
  return GREEN;
}

function bar(x, y, width, height, ratio, color) {
  const filled = Math.max(4, Math.round(width * Math.min(1, Math.max(0, ratio))));
  return (
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${height / 2}" fill="#2c2c33"/>` +
    `<rect x="${x}" y="${y}" width="${filled}" height="${height}" rx="${height / 2}" fill="${color}"/>`
  );
}

export function renderApprove({ pending, tool, count }) {
  if (!pending) {
    const body =
      `<path d="M62 96l26 26 50-58" fill="none" stroke="${GREY}" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/>` +
      text('Allow', SIZE / 2, 168, 22, { fill: GREY });
    return toDataUrl(doc(body, BG_COLD));
  }
  const body =
    `<path d="M56 88l24 24 46-54" fill="none" stroke="${GREEN}" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/>` +
    text('ALLOW', SIZE / 2, 148, 26, { fill: GREEN, weight: '800' }) +
    text(clip(tool, 14), SIZE / 2, 178, 22, { fill: TEXT }) +
    queueBadge(count);
  return toDataUrl(doc(body, BG_HOT));
}

// "Always" is an allow plus a rule for the rest of that session, so the key
// shows the rule it is about to create rather than just the tool.
export function renderAlways({ pending, rule, count }) {
  if (!pending) {
    const body =
      `<path d="M60 92l22 22 44-50" fill="none" stroke="${GREY}" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/>` +
      text('∞', 150, 104, 40, { fill: GREY, weight: '800' }) +
      text('Always', SIZE / 2, 168, 22, { fill: GREY });
    return toDataUrl(doc(body, BG_COLD));
  }
  const label = rule ? rule.label : 'this tool';
  const body =
    `<path d="M52 84l22 22 44-50" fill="none" stroke="${AMBER}" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/>` +
    text('∞', 146, 96, 40, { fill: AMBER, weight: '800' }) +
    text('ALWAYS', SIZE / 2, 146, 24, { fill: AMBER, weight: '800' }) +
    text(clip(label, 18), SIZE / 2, 176, fitSize(clip(label, 18), 20), { fill: TEXT }) +
    queueBadge(count);
  return toDataUrl(doc(body, BG));
}

export function renderDeny({ pending, tool, count }) {
  if (!pending) {
    const body =
      `<path d="M70 70l60 60M130 70l-60 60" fill="none" stroke="${GREY}" stroke-width="16" stroke-linecap="round"/>` +
      text('Deny', SIZE / 2, 168, 22, { fill: GREY });
    return toDataUrl(doc(body, BG_COLD));
  }
  const body =
    `<path d="M66 60l56 56M122 60l-56 56" fill="none" stroke="${RED}" stroke-width="16" stroke-linecap="round"/>` +
    text('DENY', SIZE / 2, 148, 26, { fill: RED, weight: '800' }) +
    text(clip(tool, 14), SIZE / 2, 178, 22, { fill: TEXT }) +
    queueBadge(count);
  return toDataUrl(doc(body, BG));
}

// One key per answer to a pending AskUserQuestion. The label is the whole
// point, so it wraps onto three lines rather than being clipped to nothing.
// Plan usage: the 5-hour rolling window or the 7-day one, as a percentage with
// the same colour scale as the context bar and a countdown to the reset.
export function renderUsage({ metric, usage, error, expired }) {
  const label = metric === '7d' ? 'Weekly' : '5 hours';

  if (error) {
    const message =
      error === 'NO_TOKEN' ? 'no login' : error === 'NETWORK' ? 'offline' : expired ? 'expired' : 'reauth';
    const body =
      text(label, SIZE / 2, 76, 22, { fill: MUTED }) +
      text(message, SIZE / 2, 122, 30, { fill: RED, weight: '800' }) +
      text('sign in again', SIZE / 2, 158, 16, { fill: GREY });
    return toDataUrl(doc(body, BG_COLD));
  }

  if (!usage) {
    const body = text(label, SIZE / 2, 100, 24, { fill: MUTED }) +
      text('...', SIZE / 2, 140, 26, { fill: GREY });
    return toDataUrl(doc(body, BG_COLD));
  }

  const ratio = usage.ratio;
  const color = contextColor(ratio);
  const body =
    text(label, SIZE / 2, 48, 22, { fill: MUTED, weight: '700' }) +
    text(`${Math.round(ratio * 100)}%`, SIZE / 2, 116, 56, { fill: color, weight: '800' }) +
    bar(18, 134, SIZE - 36, 14, ratio, color) +
    text(usage.reset ? `resets ${usage.reset}` : '', SIZE / 2, 176, 18, { fill: MUTED });
  return toDataUrl(doc(body, BG));
}

// The D200's wide slot (3_2) is 464x196 rather than a square key, which is room
// for the whole picture: which session, what it is doing, on what, and how full
// its window is. Ulanzi Studio will not let you drag onto that slot, so this is
// painted onto whatever the profile JSON has been pointed at it.
const BOARD_W = 464;
const BOARD_H = 196;

function boardDoc(body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BOARD_W} ${BOARD_H}" width="${BOARD_W}" height="${BOARD_H}"><rect width="${BOARD_W}" height="${BOARD_H}" rx="18" fill="${BG}"/>${body}</svg>`;
}

export function renderBoard({ session, pending, question, flashOn, listening }) {
  if (listening === false) {
    const body =
      `<rect x="3" y="3" width="${BOARD_W - 6}" height="${BOARD_H - 6}" rx="16" fill="none" stroke="${RED}" stroke-width="5"/>` +
      text('PLUGIN OFFLINE', 24, 74, 32, { fill: RED, weight: '800', anchor: 'start' }) +
      text('nothing is listening on port 9247 -- another copy still running?', 24, 112, 17, {
        fill: MUTED,
        anchor: 'start',
      }) +
      text('Claude Code falls back to asking in the terminal', 24, 140, 17, {
        fill: GREY,
        anchor: 'start',
      });
    return toDataUrl(boardDoc(body));
  }
  if (!session) {
    const body =
      text('no session', BOARD_W / 2, 92, 30, { fill: GREY, weight: '700' }) +
      text('waiting for Claude Code', BOARD_W / 2, 126, 18, { fill: '#33333a' });
    return toDataUrl(boardDoc(body));
  }

  const style = STATE_STYLE[session.state] || STATE_STYLE.idle;
  const lit = !style.flash || flashOn;
  const accent = lit ? style.color : '#3a3a42';
  const ratio = session.context ? session.context.ratio : null;
  const ctx = session.context || {};

  // A question or a pending request outranks the status line: it is the thing
  // actually wanting a human.
  const heading = question
    ? question.header
    : pending
      ? pending.tool
      : style.label;
  const detail = question
    ? question.question
    : pending
      ? pending.detail
      : [ctx.model, ctx.effort, ctx.branch].filter(Boolean).join(' · ');

  const name = session.project || session.id.slice(0, 8);
  const chip =
    `<circle cx="28" cy="30" r="7" fill="${accent}"/>` +
    text('SESSION', 46, 36, 15, { fill: MUTED, weight: '800', anchor: 'start' }) +
    text(heading.toUpperCase(), 118, 36, 15, { fill: accent, weight: '800', anchor: 'start' });

  const pct = ratio == null ? '--' : `${Math.round(ratio * 100)}%`;
  const body =
    chip +
    text(clip(name, 26), 24, 100, fitSize(clip(name, 26), 44, BOARD_W - 140), {
      fill: TEXT,
      weight: '800',
      anchor: 'start',
    }) +
    text(clip(detail, 52), 24, 132, 17, { fill: MUTED, anchor: 'start' }) +
    bar(24, 154, BOARD_W - 110, 14, ratio == null ? 0 : ratio, contextColor(ratio || 0)) +
    text(pct, BOARD_W - 24, 166, 20, {
      fill: contextColor(ratio || 0),
      weight: '800',
      anchor: 'end',
    }) +
    (pending && pending.secondsLeft != null
      ? text(`${pending.secondsLeft}s`, BOARD_W - 24, 36, 18, { fill: AMBER, anchor: 'end' })
      : '');

  return toDataUrl(boardDoc(body));
}

export function renderChoice({ index, choice, header }) {
  const number = index + 1;
  if (!choice) {
    const body =
      text(String(number), SIZE / 2, 110, 64, { fill: '#2f2f37', weight: '800' }) +
      text('no question', SIZE / 2, 158, 16, { fill: '#2f2f37' });
    return toDataUrl(doc(body, BG_COLD));
  }

  const words = String(choice.label || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > 14 && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
    if (lines.length === 3) break;
  }
  if (line && lines.length < 3) lines.push(line);

  const size = lines.length >= 3 ? 20 : lines.length === 2 ? 23 : 26;
  const top = lines.length >= 3 ? 96 : lines.length === 2 ? 106 : 118;
  const body =
    `<circle cx="30" cy="30" r="19" fill="${PURPLE}"/>` +
    text(String(number), 30, 38, 24, { fill: '#1f1f23', weight: '800' }) +
    text(clip(header || '', 16), SIZE / 2 + 12, 36, 16, { fill: MUTED }) +
    lines
      .map((l, i) => text(l, SIZE / 2, top + i * (size + 6), size, { fill: TEXT, weight: '700' }))
      .join('');
  return toDataUrl(doc(body, BG));
}

export function renderNext({ count, position }) {
  if (!count) {
    const body = `<path d="M78 62l40 38-40 38" fill="none" stroke="${GREY}" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/>`;
    return toDataUrl(doc(body, BG_COLD));
  }
  const body =
    `<path d="M74 54l40 38-40 38" fill="none" stroke="${TEXT}" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/>` +
    text(`${position}/${count}`, SIZE / 2, 172, 26, { fill: MUTED });
  return toDataUrl(doc(body, BG));
}

// One key, one Claude Code session: project name, what it is doing, and how
// full its context window is. States that need a human alternate between two
// brightnesses so they cannot be missed in a row of keys.
export function renderSession({ session, slot, flashOn, pending, listening }) {
  // Silence has two causes and they need different reactions: nothing is
  // happening, or nothing can happen. Saying "idle" for the second is a lie.
  if (listening === false) {
    const body =
      `<rect x="3" y="3" width="${SIZE - 6}" height="${SIZE - 6}" rx="22" fill="none" stroke="${RED}" stroke-width="6"/>` +
      text('offline', SIZE / 2, 96, 30, { fill: RED, weight: '800' }) +
      text('port 9247', SIZE / 2, 128, 18, { fill: MUTED }) +
      text('in use?', SIZE / 2, 150, 18, { fill: MUTED });
    return toDataUrl(doc(body, BG_COLD));
  }
  if (!session) {
    const body =
      text('no session', SIZE / 2, 96, 22, { fill: GREY }) +
      text(`slot ${slot + 1}`, SIZE / 2, 128, 18, { fill: '#33333a' });
    return toDataUrl(doc(body, BG_COLD));
  }

  const style = STATE_STYLE[session.state] || STATE_STYLE.idle;
  const lit = !style.flash || flashOn;
  const accent = lit ? style.color : '#3a3a42';
  const name = session.project || session.id.slice(0, 8);
  const ratio = session.context ? session.context.ratio : null;
  const pct = ratio == null ? null : Math.round(ratio * 100);

  const border = `<rect x="3" y="3" width="${SIZE - 6}" height="${SIZE - 6}" rx="22" fill="none" stroke="${accent}" stroke-width="6"/>`;

  // While this session is waiting on a decision, the key answers the only
  // question that matters -- what exactly am I being asked to allow?
  if (pending) {
    const seconds = pending.secondsLeft == null ? '' : `${pending.secondsLeft}s`;
    return toDataUrl(
      doc(
        border +
          text(name, SIZE / 2, 38, fitSize(name, 22, SIZE - 40), { fill: MUTED, weight: '700' }) +
          text(clip(pending.tool, 12), SIZE / 2, 86, fitSize(clip(pending.tool, 12), 34), {
            fill: TEXT,
            weight: '800',
          }) +
          text(clip(pending.detail, 24), SIZE / 2, 118, 17, { fill: accent }) +
          text(seconds, SIZE / 2, 152, 22, { fill: AMBER }) +
          bar(18, 166, SIZE - 36, 12, ratio == null ? 0 : ratio, contextColor(ratio || 0)),
        BG
      )
    );
  }

  const title = text(name, SIZE / 2, 92, fitSize(name, 38), { fill: TEXT, weight: '800' });
  const stateWord = text(style.label, 18, 138, 22, { fill: accent, anchor: 'start' });
  const pctText =
    pct == null
      ? text('--', SIZE - 18, 138, 22, { fill: MUTED, anchor: 'end' })
      : text(`${pct}%`, SIZE - 18, 138, 22, { fill: contextColor(ratio), anchor: 'end' });
  const meter = bar(18, 150, SIZE - 36, 14, ratio == null ? 0 : ratio, contextColor(ratio || 0));
  const ruleBadge = session.rules
    ? text(`∞${session.rules}`, SIZE / 2, 188, 16, { fill: MUTED })
    : '';

  return toDataUrl(doc(border + title + stateWord + pctText + meter + ruleBadge, BG));
}
