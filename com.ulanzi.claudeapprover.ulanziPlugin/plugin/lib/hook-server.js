import http from 'http';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';

import { SessionRegistry, State } from './sessions.js';
import { RuleBook, ruleFor } from './rules.js';

const MAX_BODY = 1024 * 1024; // hook payloads carry tool_input; 1 MB is plenty
const RETRY_MS = 5000;

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
    this.diag = []; // last few key events, for identifying actions from evidence
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
          diag: this.diag,
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
      let hook;
      try {
        hook = JSON.parse(body || '{}');
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      try {
        this._dispatch(hook, res);
      } catch (err) {
        this.emit('log', `dispatch failed: ${err.message}`);
        if (!res.writableEnded) this._ack(res);
      }
    });
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

      case 'UserPromptSubmit':
      case 'PreToolUse':
      case 'PostToolUse':
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
