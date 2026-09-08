// "Always allow" cannot be expressed through the hook protocol: a
// PermissionRequest hook may only answer allow / deny / ask, and there is no
// field for writing a permission rule back into Claude Code. So the rule lives
// here instead — remembered per session, applied before the key ever lights up,
// and forgotten when the session ends. Nothing is written to the user's config.

// Commands whose first word says nothing useful on its own: `git` covers the
// whole VCS, so a rule for `git push` should not also cover `git reset --hard`.
const TWO_WORD = new Set([
  'git', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno', 'cargo', 'go', 'dotnet',
  'docker', 'kubectl', 'gh', 'pip', 'pip3', 'python', 'python3', 'node',
  'terraform', 'aws', 'az', 'gcloud', 'brew', 'apt', 'winget', 'choco', 'make',
]);

function words(command) {
  return String(command || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

// The rule a press of "Always" would create for this request.
export function ruleFor(entry) {
  if (!entry) return null;
  // "Always answer questions this way" is meaningless -- each question differs.
  if (entry.tool === 'AskUserQuestion') return null;
  if (entry.tool === 'Bash') {
    const parts = words(entry.input && entry.input.command);
    if (!parts.length) return null;
    const head = parts[0].toLowerCase();
    const takeTwo = TWO_WORD.has(head) && parts[1] && !parts[1].startsWith('-');
    const prefix = takeTwo ? `${parts[0]} ${parts[1]}` : parts[0];
    return { kind: 'bash', value: prefix, label: `${prefix} *` };
  }
  return { kind: 'tool', value: entry.tool, label: `${entry.tool} *` };
}

function matches(rule, entry) {
  if (!rule || !entry) return false;
  if (rule.kind === 'bash') {
    if (entry.tool !== 'Bash') return false;
    const command = words(entry.input && entry.input.command).join(' ');
    const prefix = rule.value;
    // Prefix match on whole words only, so `git p` never matches `git push`.
    return command === prefix || command.startsWith(prefix + ' ');
  }
  return entry.tool === rule.value;
}

export class RuleBook {
  constructor() {
    this.bySession = new Map(); // session_id -> rule[]
  }

  add(sessionId, rule) {
    if (!sessionId || !rule) return null;
    const list = this.bySession.get(sessionId) || [];
    if (!list.some((r) => r.kind === rule.kind && r.value === rule.value)) {
      list.push(rule);
      this.bySession.set(sessionId, list);
    }
    return rule;
  }

  // The rule that would auto-allow this request, if any.
  find(entry) {
    const list = this.bySession.get(entry && entry.session);
    if (!list) return null;
    return list.find((rule) => matches(rule, entry)) || null;
  }

  clear(sessionId) {
    this.bySession.delete(sessionId);
  }

  count(sessionId) {
    return (this.bySession.get(sessionId) || []).length;
  }
}
