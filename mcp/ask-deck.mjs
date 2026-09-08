#!/usr/bin/env node
/**
 * An MCP server whose only tool asks a question on the Ulanzi deck and waits.
 *
 * Claude Code's built-in AskUserQuestion cannot be answered from a deck: the
 * permission hook may only allow or deny, and a denial reads as "dismissed"
 * rather than as an answer. An MCP tool call, by contrast, blocks until the
 * server returns -- so the answer travels back as an ordinary tool result.
 *
 * Register once:
 *   claude mcp add --scope user --transport stdio ask-deck -- node <path to this file>
 *
 * Speaks MCP over stdio: newline-delimited JSON-RPC 2.0 on stdin/stdout.
 * Nothing may be written to stdout except protocol messages, so all logging
 * goes to stderr.
 */
import http from 'http';
import readline from 'readline';

const PLUGIN = { host: '127.0.0.1', port: Number(process.env.ASK_DECK_PORT) || 9247 };
const SERVER_INFO = { name: 'ask-deck', version: '1.0.0' };
const FALLBACK_PROTOCOL = '2025-06-18';

function log(...args) {
  process.stderr.write('[ask-deck] ' + args.join(' ') + '\n');
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

const TOOL = {
  name: 'ask_on_deck',
  title: 'Ask on the Ulanzi deck',
  description:
    'Ask the user a multiple-choice question and wait for them to answer it by pressing a key ' +
    'on their Ulanzi deck. Each option appears on its own Answer key. Prefer this over ' +
    'AskUserQuestion whenever the user is at their deck, because a deck press cannot answer ' +
    'AskUserQuestion. Returns the label of the option they chose. Blocks until they answer, ' +
    'so only call it when a decision genuinely needs their input.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question, phrased as a full sentence.' },
      header: {
        type: 'string',
        description: 'A short label for the question, at most about 16 characters.',
      },
      options: {
        type: 'array',
        minItems: 2,
        maxItems: 4,
        description: 'The answers to offer, in order. Each becomes one Answer key.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Short answer text shown on the key.' },
            description: { type: 'string', description: 'What choosing this means.' },
          },
          required: ['label'],
        },
      },
    },
    required: ['question', 'options'],
  },
};

// Hand the question to the plugin and hold the connection open. The plugin does
// not answer until a key is pressed, which is exactly the behaviour we want:
// the MCP call stays outstanding and Claude waits.
function askPlugin(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      {
        host: PLUGIN.host,
        port: PLUGIN.port,
        path: '/ask',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw || '{}'));
          } catch (err) {
            reject(new Error('plugin sent something that was not JSON: ' + err.message));
          }
        });
      }
    );
    req.on('error', (err) => reject(err));
    req.end(body);
  });
}

async function callTool(id, params) {
  const args = (params && params.arguments) || {};
  const options = Array.isArray(args.options) ? args.options.filter((o) => o && o.label) : [];

  if (!args.question || options.length < 2) {
    return fail(id, -32602, 'ask_on_deck needs a question and at least two options');
  }

  try {
    const answer = await askPlugin({
      question: args.question,
      header: args.header || '',
      options: options.slice(0, 4),
    });

    if (answer.cancelled) {
      return reply(id, {
        content: [
          {
            type: 'text',
            text:
              'The user did not answer on the deck (' +
              (answer.reason || 'no answer') +
              '). Ask them in the conversation instead.',
          },
        ],
      });
    }

    log('answered:', answer.label);
    return reply(id, {
      content: [{ type: 'text', text: 'The user chose: ' + answer.label }],
      structuredContent: { label: answer.label, index: answer.index },
    });
  } catch (err) {
    // The deck plugin being absent must never break the session -- say so and
    // let Claude fall back to asking in the conversation.
    log('plugin unreachable:', err.message);
    return reply(id, {
      content: [
        {
          type: 'text',
          text:
            'The Ulanzi deck plugin is not reachable (' +
            err.message +
            '). Ask the user in the conversation instead.',
        },
      ],
      isError: true,
    });
  }
}

function handle(message) {
  const { id, method, params } = message;

  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: (params && params.protocolVersion) || FALLBACK_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return; // notifications carry no id and expect no reply

    case 'tools/list':
      return reply(id, { tools: [TOOL] });

    case 'tools/call':
      if (!params || params.name !== TOOL.name) {
        return fail(id, -32602, 'unknown tool: ' + (params && params.name));
      }
      return callTool(id, params);

    case 'ping':
      return reply(id, {});

    default:
      if (id !== undefined) fail(id, -32601, 'method not found: ' + method);
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return log('ignoring unparseable line');
  }
  try {
    handle(message);
  } catch (err) {
    log('handler threw:', err.stack || err.message);
    if (message.id !== undefined) fail(message.id, -32603, err.message);
  }
});

log('ready, talking to the deck plugin on port ' + PLUGIN.port);
