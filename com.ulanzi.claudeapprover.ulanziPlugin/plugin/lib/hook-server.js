import http from 'http';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';

import { SessionRegistry, State } from './sessions.js';
import { RuleBook, ruleFor } from './rules.js';

const MAX_BODY = 1024 * 1024; // hook payloads carry tool_input; 1 MB is plenty
const RETRY_MS = 5000;
const MAX_CHOICES = 4;
const MAX_QUESTIONS = 4;

// AskUserQuestion is a tool, so it arrives as a permission request like any
// other -- but "allow" only means "let Claude show me the question", which is
// not what a deck key should imply. The options travel in tool_input, so the
// deck can offer them directly instead.
function parseChoices(hook) {
  if (hook.tool_name !== 'AskUserQuestion') return null;
  const questions = hook.tool_input && hook.tool_input.questions;
  if (!Array.isArray(questions) || !questions.length) return null;
  const q = questions[0];
  const options = Array.isArray(q.options) ? q.options.slice(0, MAX_CHOICES) : [];
  if (!options.length) return null;
  return {
    header: q.header || 'Question',
    question: q.question || '',
    // Only the first question is offered: the deck has no way to walk a
    // multi-question form, and those are rare.
    more: questions.length > 1,
    options: options.map((o) => ({ label: o.label, description: o.description })),
  };
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

    this._answer(entry, decision, reason || (rule ? `Session rule: ${rule.label}` : undefined));
    return { entry, rule };
  }

  // The question stops being answerable once Claude has moved on.
  clearQuestion(sessionId) {
    if (!this.question) return;
    if (sessionId && this.question.session && this.question.session !== sessionId) return;
    if (this.question.res) {
      // An MCP question outlives the tool call that raised it only if we leave
      // it hanging, so close it properly.
      this._closeQuestion({ cancelled: true, reason: 'the session moved on' });
      return;
    }
    this.question = null;
    this.emit('change');
  }

  _answer(entry, decision, reason) {
    this._resolve(entry, {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision,
        decisionReason:
          reason || `${decision === 'allow' ? 'Approved' : 'Denied'} from Ulanzi deck`,
      },
    });
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
      entry.res.writeHead(200, { 'Content-Type': 'application/json' });
      entry.res.end(JSON.stringify(payload));
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

    // The MCP server posts questions here and the response is held until a key
    // is pressed, so an MCP tool call can carry a real answer back to Claude --
    // something the permission hook has no field for.
    if (req.url === '/ask') {
      this._readBody(req, res, (payload) => this._ask(payload, res));
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

  // A question from the MCP server. Unlike a permission request there is no
  // sensible timeout default: Claude is simply waiting, and so is the user.
  _ask(payload, res) {
    // A call may carry several questions; the keys walk through them in order
    // and the answers come back together, so a three-part decision costs one
    // tool call rather than three round trips.
    const raw = Array.isArray(payload.questions)
      ? payload.questions
      : [{ header: payload.header, question: payload.question, options: payload.options }];

    const items = raw.slice(0, MAX_QUESTIONS).map((q) => ({
      header: q.header || 'Question',
      question: q.question || '',
      options: (Array.isArray(q.options) ? q.options : [])
        .slice(0, MAX_CHOICES)
        .map((o) => ({ label: o.label, description: o.description })),
    }));

    const usable = items.filter((q) => q.question && q.options.length >= 2);
    if (!usable.length || usable.length !== items.length) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ cancelled: true, reason: 'malformed question' }));
      return;
    }

    // Only one question can be on the keys at a time; a new one supersedes.
    if (this.question && this.question.res) {
      this._closeQuestion({ cancelled: true, reason: 'superseded by a newer question' });
    }

    this.question = { items, index: 0, answers: [], res, at: Date.now() };
    this.emit('log', `${items.length} question(s) on the keys: ${items[0].header}`);
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
    if (question && question.res && !question.res.writableEnded) {
      try {
        question.res.writeHead(200, { 'Content-Type': 'application/json' });
        question.res.end(JSON.stringify(payload));
      } catch (err) {
        this.emit('log', `could not answer the question: ${err.message}`);
      }
    }
    this.emit('change');
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
        if (hook.tool_name === 'AskUserQuestion') this.clearQuestion(hook.session_id);
        if (session && session.state !== State.APPROVAL) session.state = State.WORKING;
        break;

      case 'UserPromptSubmit':
      case 'PreToolUse':
      case 'PostToolUseFailure':
      case 'PermissionDenied':
        // PreToolUse is deliberately status-only. Holding it would block every
        // single tool call on a key press, which is not what anyone wants.
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
    // A question is not a yes/no decision. Let it through at once so Claude
    // shows its picker, and remember the options so the Answer keys can drive
    // that picker with a keystroke.
    const choices = parseChoices(hook);
    if (choices) {
      this.question = {
        items: [{ header: choices.header, question: choices.question, options: choices.options }],
        index: 0,
        answers: [],
        res: null, // nothing to answer: Claude Code's own picker owns this one
        session: hook.session_id || '',
        at: Date.now(),
      };
      this.emit('log', `question: ${choices.header}`);
      this.emit('change');
      this._ack(res);
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
      event: hook.hook_event_name,
      session: hook.session_id || '',
      cwd: hook.cwd || '',
      tool: hook.tool_name || 'Tool',
      input: hook.tool_input || {},
      createdAt: Date.now(),
      expiresAt: Date.now() + this.options.holdSeconds * 1000,
    };

    // An "always" rule from earlier in this session answers before the key ever
    // lights up — that is the whole point of having pressed it.
    const rule = this.rules.find(entry);
    if (rule) {
      this.emit('log', `auto-allow ${entry.tool} via ${rule.label}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: 'allow',
            decisionReason: `Session rule: ${rule.label}`,
          },
        })
      );
      this.emit('change');
      return;
    }

    entry.timer = setTimeout(() => this._expire(entry), this.options.holdSeconds * 1000);
    this.queue.push(entry);
    if (session) session.state = State.APPROVAL;
    this.emit('log', `pending ${entry.tool} from ${entry.cwd}`);
    this.emit('change');
  }

  _expire(entry) {
    const payload =
      this.options.onTimeout === 'deny'
        ? {
            hookSpecificOutput: {
              hookEventName: 'PermissionRequest',
              decision: 'deny',
              decisionReason: 'No answer from the Ulanzi deck before the hook timed out',
            },
          }
        : {}; // no decision — Claude Code prompts in the terminal as usual
    this.emit('log', `expired ${entry.tool} (${this.options.onTimeout})`);
    const stillQueued = this.queue.filter((e) => e !== entry && e.session === entry.session);
    if (!stillQueued.length) this.sessions.setState(entry.session, State.WORKING);
    this._resolve(entry, payload);
  }
}
