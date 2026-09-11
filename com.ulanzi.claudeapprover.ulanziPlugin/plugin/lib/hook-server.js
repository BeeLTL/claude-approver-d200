import http from 'http';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';

import { SessionRegistry, State } from './sessions.js';
import { RuleBook, ruleFor, permissionEntryFor } from './rules.js';

const MAX_BODY = 1024 * 1024; // hook payloads carry tool_input; 1 MB is plenty
const RETRY_MS = 5000;
const MAX_CHOICES = 4;
const MAX_QUESTIONS = 4;

// AskUserQuestion is a tool, so it arrives as a permission request like any
// other -- but a plain "allow" only means "let Claude show me the question",
// which is not what a deck key should imply. The options travel in tool_input,
// so the deck can offer them directly and hand the answer back as updatedInput.
function parseChoices(hook) {
  if (hook.tool_name !== 'AskUserQuestion') return null;
  const questions = hook.tool_input && hook.tool_input.questions;
  if (!Array.isArray(questions) || !questions.length) return null;
  const items = questions.slice(0, MAX_QUESTIONS).map((q) => ({
    header: q.header || 'Question',
    question: q.question || '',
    options: (Array.isArray(q.options) ? q.options : [])
      .slice(0, MAX_CHOICES)
      .map((o) => ({ label: o.label, description: o.description })),
  }));
  // Anything the keys cannot express is left to Claude Code's own picker.
  if (items.some((q) => !q.options.length || !q.question)) return null;
  return items;
}

// Claude Code shows its own permission prompt while the hook is still running,
// so the deck and the terminal race for the same decision. The tool event that
// follows a request settled in the terminal carries the same tool_use_id, which
// is one of the two ways we learn that a lit key is already dead -- the other
// being Claude Code dropping the connection it was holding.
function sameRequest(entry, hook) {
  if (hook.tool_use_id && entry.toolUseId) return hook.tool_use_id === entry.toolUseId;
  // A host that omits tool_use_id still identifies the call by what it is.
  return (
    entry.session === (hook.session_id || '') &&
    entry.tool === (hook.tool_name || '') &&
    JSON.stringify(entry.input) === JSON.stringify(hook.tool_input || {})
  );
}

// A Claude Code PermissionRequest hook is an HTTP POST whose *response* carries
// the decision. We simply do not answer it until a deck key is pressed, which
// turns the deck into the permission prompt. Every other event is answered at
// once and only feeds the session status keys.
export class HookServer extends EventEmitter {
  constructor() {
    super();
    this.server = null;
    this.listening = false;
    this.port = null;
    this.retryTimer = null;
    this.queue = [];
    this.cursor = 0;
    this.question = null; // the question Claude is currently showing, if any
    this.sessions = new SessionRegistry();
    this.rules = new RuleBook();
    this.options = { holdSeconds: 110, onTimeout: 'ask', cwdFilter: '', token: '' };
  }

  configure(options) {
    Object.assign(this.options, options || {});
  }

  start(port, options) {
    this.configure(options);
    if (this.listening && this.port === port) return;
    this.stop();
    this.port = port;
    this.server = http.createServer((req, res) => this._handle(req, res));
    this.server.on('error', (err) => {
      this.listening = false;
      this.emit('log', `listen failed on ${port}: ${err.message}`);
      this.emit('change');
      // Usually a stale instance still holding the port. Keep trying so the
      // plugin heals itself once it is freed, instead of sitting dead until
      // Ulanzi Studio is restarted.
      this._scheduleRetry(port);
    });
    // 127.0.0.1 only: the decision endpoint must never be reachable off-box.
    this.server.listen(port, '127.0.0.1', () => {
      this.listening = true;
      this.emit('log', `listening on 127.0.0.1:${port}`);
      this.emit('change');
    });
  }

  _scheduleRetry(port) {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (this.listening) return;
      this.emit('log', `retrying listen on ${port}`);
      this.stop();
      this.start(port, this.options);
    }, RETRY_MS);
  }

  stop() {
    clearTimeout(this.retryTimer);
    // Never leave a session hanging on a socket we are about to drop: answer
    // everything still queued with "no decision" so Claude Code prompts in the
    // terminal instead.
    for (const entry of [...this.queue]) this._resolve(entry, {});
    if (this.question && this.question.res) {
      this._closeQuestion({ cancelled: true, reason: 'the deck plugin restarted' });
    }
    if (this.server) {
      const srv = this.server;
      this.server = null;
      try { srv.closeAllConnections?.(); } catch { /* older node */ }
      try { srv.close(); } catch { /* already closed */ }
    }
    this.listening = false;
  }

  get current() {
    if (!this.queue.length) return null;
    if (this.cursor >= this.queue.length) this.cursor = 0;
    return this.queue[this.cursor];
  }

  next() {
    if (this.queue.length < 2) return;
    this.cursor = (this.cursor + 1) % this.queue.length;
    this.emit('change');
  }

  // The rule a press of "Always" would add for the request on screen.
  pendingRule() {
    return ruleFor(this.current);
  }

  // decision: 'allow' | 'deny'. always=true also remembers the rule.
  decide(decision, { always = false, reason } = {}) {
    const entry = this.current;
    if (!entry) return null;

    let rule = null;
    if (always && decision === 'allow') {
      rule = this.rules.add(entry.session, ruleFor(entry));
      const session = this.sessions.sessions.get(entry.session);
      if (session) session.rules = this.rules.count(entry.session);
    }

    this._answer(entry, decision, reason || (rule ? `Session rule: ${rule.label}` : undefined), rule);
    return { entry, rule };
  }

  // The question stops being answerable once Claude has moved on.
  clearQuestion(sessionId) {
    if (!this.question) return;
    if (sessionId && this.question.session && this.question.session !== sessionId) return;
    if (this.question.res) {
      // The question is holding a permission response open; releasing it without
      // a decision hands the ask back to Claude Code.
      this._closeQuestion({ cancelled: true, reason: 'the session moved on' });
      return;
    }
    this.question = null;
    this.emit('change');
  }

  // The documented reply shape: `decision` is an object, not a string. Its
  // fields are behavior, updatedInput, updatedPermissions, message and
  // interrupt. updatedInput is the interesting one: a tool runs with the input
  // it returns, which is how a key press answers a question rather than merely
  // permitting it.
  _decision(behavior, { message, updatedPermissions, updatedInput } = {}) {
    const decision = { behavior };
    if (behavior === 'deny' && message) decision.message = message;
    if (behavior === 'allow' && updatedPermissions) decision.updatedPermissions = updatedPermissions;
    // updatedInput is how a question gets answered: the tool runs with the
    // answer already in its input instead of asking for it.
    if (behavior === 'allow' && updatedInput) decision.updatedInput = updatedInput;
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
  }

  _answer(entry, decision, reason, rule) {
    // Always Allow hands Claude Code the rule rather than only remembering it
    // here: as a session-scoped allow rule it owns the decision from then on,
    // so matching calls never reach this plugin at all. The local RuleBook
    // stays as a fallback for a host that ignores the field.
    const updatedPermissions = rule ? [permissionEntryFor(rule)].filter(Boolean) : undefined;
    this._resolve(
      entry,
      this._decision(decision, {
        message: reason || 'Denied from the Ulanzi deck',
        updatedPermissions,
      })
    );
    // Claude carries on the moment we answer, so the session is working again
    // unless something else is still queued for it.
    const stillQueued = this.queue.some((e) => e.session === entry.session);
    if (!stillQueued) this.sessions.setState(entry.session, State.WORKING);
  }

  _resolve(entry, payload) {
    const i = this.queue.indexOf(entry);
    if (i === -1) return;
    this.queue.splice(i, 1);
    if (this.cursor >= this.queue.length) this.cursor = 0;
    clearTimeout(entry.timer);
    try {
      // The socket may already be gone: Claude Code closes it the moment the
      // request is settled somewhere else. Nothing to answer then.
      if (!entry.res.writableEnded && !entry.res.destroyed) {
        entry.res.writeHead(200, { 'Content-Type': 'application/json' });
        entry.res.end(JSON.stringify(payload));
      }
    } catch (err) {
      this.emit('log', `could not answer ${entry.id}: ${err.message}`);
    }
    this.emit('change');
  }

  _handle(req, res) {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          pending: this.queue.length,
          question: this.currentQuestion
            ? {
                header: this.currentQuestion.header,
                options: this.currentQuestion.options.map((o) => o.label),
                step: this.question.index + 1,
                of: this.question.items.length,
              }
            : null,
          sessions: this.sessions.ordered().map((s) => ({
            project: s.project,
            state: s.state,
            context: s.context ? Math.round(s.context.ratio * 100) : null,
            rules: s.rules,
          })),
        })
      );
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }

    if (this.options.token && req.headers['x-approver-token'] !== this.options.token) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }

    this._readBody(req, res, (hook) => {
      try {
        this._dispatch(hook, res);
      } catch (err) {
        this.emit('log', `dispatch failed: ${err.message}`);
        if (!res.writableEnded) this._ack(res);
      }
    });
  }

  _readBody(req, res, onJson) {
    let body = '';
    let aborted = false;
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) {
        aborted = true;
        res.writeHead(413).end();
        req.destroy();
      }
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        onJson(JSON.parse(body || '{}'));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{}');
      }
    });
  }

  // A question arrives as a permission request, so answering it means answering
  // that request -- and the hold applies: a question nobody presses must fall
  // back to Claude Code's own picker rather than keep the session waiting on a
  // key that is not going to be pressed.
  _askOnKeys(hook, res, items) {
    if (this.question && this.question.res) {
      this._closeQuestion({ cancelled: true, reason: 'superseded by a newer question' });
    }

    const question = {
      items,
      index: 0,
      answers: [],
      res,
      session: hook.session_id || '',
      // The tool wants its own questions back alongside the answers.
      original: (hook.tool_input && hook.tool_input.questions) || [],
    };

    question.timer = setTimeout(
      () => this._closeQuestion({ cancelled: true, reason: 'nobody pressed a key' }),
      this.options.holdSeconds * 1000
    );

    // Claude Code shows its own picker at the same time, exactly as it does for
    // a permission. If it gets the answer first, the socket closes and the keys
    // go dark instead of offering a choice that has already been made.
    res.on('close', () => {
      if (res.writableEnded) return;
      if (this.question !== question) return;
      clearTimeout(question.timer);
      this.question = null;
      this.emit('log', 'the question was answered in Claude Code, clearing the keys');
      this.emit('change');
    });

    this.question = question;
    this.emit('log', `question on the keys: ${items[0].header}`);
    this.emit('change');
  }

  // The question currently on the keys, of however many are in flight.
  get currentQuestion() {
    const q = this.question;
    if (!q || !q.items) return null;
    return q.items[q.index] || null;
  }

  // Record an answer and move to the next question, or finish. Returns the
  // chosen option, plus whether more questions are still waiting.
  answer(index) {
    const question = this.question;
    if (!question || !question.res) return null;
    const current = this.currentQuestion;
    const option = current && current.options[index];
    if (!option) return null;

    question.answers.push({ question: current.question, header: current.header, label: option.label, index });
    question.index += 1;
    this.emit('log', `answered: ${option.label}`);

    const more = question.index < question.items.length;
    if (!more) {
      this._closeQuestion({ answers: question.answers });
    } else {
      this.emit('change'); // repaint the keys with the next question at once
    }
    return { ...option, more, remaining: question.items.length - question.index };
  }

  _closeQuestion(payload) {
    const question = this.question;
    if (question && question.answers && question.answers.length && payload.cancelled) {
      payload = { ...payload, answers: question.answers };
    }
    this.question = null;
    if (question) clearTimeout(question.timer);
    if (question && question.res && !question.res.writableEnded) {
      const body = this._answeredDecision(question, payload);
      try {
        question.res.writeHead(200, { 'Content-Type': 'application/json' });
        question.res.end(JSON.stringify(body));
      } catch (err) {
        this.emit('log', `could not answer the question: ${err.message}`);
      }
    }
    this.emit('change');
  }

  // The answers as AskUserQuestion wants them: its own questions back, plus a
  // map from each question to the label that was pressed. A question nobody
  // finished gets no decision at all, which hands it to Claude Code's picker
  // with nothing lost.
  _answeredDecision(question, payload) {
    const answers = {};
    for (const given of payload.answers || []) answers[given.question] = given.label;
    if (Object.keys(answers).length !== question.items.length) return {};
    return this._decision('allow', { updatedInput: { questions: question.original, answers } });
  }

  _ack(res) {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
  }

  _dispatch(hook, res) {
    const event = hook.hook_event_name;
    const session = this.sessions.touch(hook);

    if (event === 'PermissionRequest') {
      this._permission(hook, res, session);
      return;
    }

    switch (event) {
      case 'SessionStart':
        if (session) session.state = State.IDLE;
        break;

      case 'PostToolUse':
      case 'PostToolUseFailure':
      case 'PermissionDenied':
        if (hook.tool_name === 'AskUserQuestion') this.clearQuestion(hook.session_id);
        // The tool ran, failed, or was refused: whatever the key was asking
        // about has already been settled, so put the key out.
        this._releaseResolved(hook);
        if (session && session.state !== State.APPROVAL) session.state = State.WORKING;
        break;

      case 'UserPromptSubmit':
      case 'PreToolUse':
        // PreToolUse is deliberately status-only. Holding it would block every
        // single tool call on a key press, which is not what anyone wants. It
        // also runs *before* PermissionRequest, so it never tells us anything
        // about a request already on the keys.
        if (session && session.state !== State.APPROVAL) session.state = State.WORKING;
        break;

      case 'Notification': {
        const type = hook.notification_type;
        if (session) {
          if (type === 'permission_prompt') session.state = State.APPROVAL;
          else if (type === 'idle_prompt' || type === 'agent_needs_input') session.state = State.INPUT;
        }
        break;
      }

      case 'Stop':
      case 'SessionEnd': {
        // A session that stopped can no longer be waiting on us.
        for (const entry of [...this.queue]) {
          if (entry.session && entry.session === hook.session_id) this._expire(entry);
        }
        this.clearQuestion(hook.session_id);
        if (event === 'SessionEnd') {
          this.rules.clear(hook.session_id);
          this.sessions.remove(hook.session_id);
        } else if (session) {
          session.state = State.DONE;
        }
        break;
      }

      default:
        break;
    }

    this.emit('change');
    this._ack(res);
  }

  _permission(hook, res, session) {
    // A question is not a yes/no decision, but it is still answerable here: an
    // allow may carry updatedInput, and AskUserQuestion reads its answers from
    // exactly that. So the request is held like any other, the options go on
    // the Answer keys, and a press answers Claude's question outright.
    const choices = parseChoices(hook);
    if (choices) {
      this._askOnKeys(hook, res, choices);
      if (session) session.state = State.INPUT;
      return;
    }

    // A filter that does not match means "not my business" — answer with an
    // empty object so Claude Code falls through to its own prompt.
    const filter = (this.options.cwdFilter || '').trim().toLowerCase();
    if (filter && !String(hook.cwd || '').toLowerCase().includes(filter)) {
      this._ack(res);
      return;
    }

    const entry = {
      id: randomUUID(),
      res,
      session: hook.session_id || '',
      cwd: hook.cwd || '',
      tool: hook.tool_name || 'Tool',
      input: hook.tool_input || {},
      toolUseId: hook.tool_use_id || '',
      expiresAt: Date.now() + this.options.holdSeconds * 1000,
    };

    // An "always" rule from earlier in this session answers before the key ever
    // lights up — that is the whole point of having pressed it.
    const rule = this.rules.find(entry);
    if (rule) {
      this.emit('log', `auto-allow ${entry.tool} via ${rule.label}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this._decision('allow')));
      this.emit('change');
      return;
    }

    entry.timer = setTimeout(() => this._expire(entry), this.options.holdSeconds * 1000);
    // Claude Code's own prompt is up at the same time as the key, and answering
    // there makes it drop this request -- the socket closing with no response
    // from us is how we hear about it. res.on('close') also fires on the normal
    // path, once we have written the answer, which writableEnded rules out.
    res.on('close', () => {
      if (res.writableEnded) return;
      if (!this.queue.includes(entry)) return;
      this.emit('log', `${entry.tool} was settled in Claude Code, clearing the key`);
      this._release(entry);
    });
    this.queue.push(entry);
    if (session) session.state = State.APPROVAL;
    this.emit('log', `pending ${entry.tool} from ${entry.cwd}`);
    this.emit('change');
  }

  // Someone answered in Claude Code itself while the key was still lit. Its
  // answer is the one that counted, so drop ours without deciding anything --
  // otherwise the key goes on asking for a press that can no longer do
  // anything, for the rest of the hold.
  _releaseResolved(hook) {
    for (const entry of [...this.queue]) {
      if (!sameRequest(entry, hook)) continue;
      this.emit('log', `${entry.tool} was answered in Claude Code, clearing the key`);
      this._release(entry);
    }
  }

  _expire(entry) {
    const payload =
      this.options.onTimeout === 'deny'
        ? this._decision('deny', {
            message: 'No answer from the Ulanzi deck before the hook timed out',
          })
        : {}; // no decision — Claude Code prompts in the terminal as usual
    this.emit('log', `expired ${entry.tool} (${this.options.onTimeout})`);
    this._release(entry, payload);
  }

  // Let a request go without a decision from the keys. The default payload is
  // no decision at all, which leaves Claude Code's own permission flow in
  // charge of it.
  _release(entry, payload = {}) {
    const stillQueued = this.queue.filter((e) => e !== entry && e.session === entry.session);
    if (!stillQueued.length) this.sessions.setState(entry.session, State.WORKING);
    this._resolve(entry, payload);
  }
}
