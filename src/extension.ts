import * as vscode from 'vscode';
import * as path from 'path';
import { exec as cpExec } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { promisify } from 'util';
// If Node's global fetch isn't available in your VS Code version, this import covers it.
import { fetch } from 'undici';

const exec = promisify(cpExec);

// -------- Types the model should return --------
type ReviewIssue = {
  file: string;             // absolute or workspace-relative path
  startLine: number;        // 1-based
  endLine: number;          // inclusive
  severity: 'blocker' | 'major' | 'nit';
  message: string;
  suggestion?: string;      // optional replacement code
};

type ReviewResult = {
  summary: string;
  issues: ReviewIssue[];
};

// One diagnostics collection for the session
const diagCollection = vscode.languages.createDiagnosticCollection('ai-review');

export async function activate(context: vscode.ExtensionContext) {
  const CMD_ID = 'pr-reviewer.review';

  const disposable = vscode.commands.registerCommand(CMD_ID, async () => {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
      vscode.window.showErrorMessage('Open a folder/workspace first.');
      return;
    }
    const root = ws.uri.fsPath;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'AI Review: running…' },
      async (progress) => {
        try {
          progress.report({ message: 'Reading acceptance criteria' });
          const acceptance = await readAcceptance(ws);

          progress.report({ message: 'Collecting diff (git)' });
          const diff = await getGitDiff(root);
          if (!diff.trim()) {
            vscode.window.showInformationMessage('No local changes (git diff is empty).');
            return;
          }

          const prompt = buildPrompt({ acceptance, diff });

          progress.report({ message: 'Calling local model (Ollama)' });
          const cfg = vscode.workspace.getConfiguration('aiReviewer');
          const model = cfg.get<string>('model') || 'llama3.1:8b';
          const remoteUrl = cfg.get<string>('remoteUrl') || '';

          const review = await getReview({ prompt, model, remoteUrl });
          const fileTextByPath = new Map<string, string>();
          for (const it of review.issues) {
            const abs = toAbsolutePath(it.file, root);
            try {
              const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
              fileTextByPath.set(it.file, doc.getText());
            } catch { /* ignore missing files */ }
          }

// Remove issues that contradict explicit numeric rules in the SPEC
          review.issues = filterIssuesAgainstSpec(review.issues, acceptance, fileTextByPath);


          progress.report({ message: 'Publishing results' });
          await showReviewPanel(review, root);       // ⬅️ show summary + issues in the panel
          publishDiagnostics(review.issues, root);   // optional: keep Problems panel too

          vscode.window.showInformationMessage(`AI Review complete: ${review.issues.length} issue(s).`);
        } catch (err: any) {
          console.error(err);
          vscode.window.showErrorMessage(`AI Review failed: ${err?.message || String(err)}`);
        }
      }
    );
  });

  context.subscriptions.push(disposable, diagCollection);
}

export function deactivate() {
  diagCollection.dispose();
}

// ---------- Helpers ----------

async function readAcceptance(ws: vscode.WorkspaceFolder): Promise<string> {
  const spec = vscode.Uri.joinPath(ws.uri, '.ai-review/spec.yml').fsPath;
  if (existsSync(spec)) return readFileSync(spec, 'utf8');
  return (await vscode.window.showInputBox({
    title: 'Acceptance Criteria (optional)',
    placeHolder: 'Given…, When…, Then…; or paste any acceptance notes',
    value: ''
  })) || '';
}

async function getGitDiff(cwd: string): Promise<string> {
  await exec('git --version', { cwd }).catch(() => {
    throw new Error('Git not found in PATH.');
  });
  const { stdout } = await exec('git diff --no-color', { cwd });
  return stdout;
}

function buildPrompt(input: { acceptance: string; diff: string }) {
  return `
You are a strict PR reviewer.

AUTHORITATIVE ORDER OF TRUTH:
1) Acceptance criteria (SPEC) are absolute. If code matches the SPEC, do NOT suggest changes that violate it.
2) Correctness/security next.
3) Style/nits only when they do not conflict with the SPEC.

Output format (JSON only; no markdown/backticks):
{
  "summary": "short overview",
  "issues": [
    {
      "file": "path (absolute or workspace-relative)",
      "startLine": 10,
      "endLine": 12,
      "severity": "blocker" | "major" | "nit",
      "message": "what & why (reference the specific SPEC line if applicable)",
      "suggestion": "optional minimal patch"
    }
  ]
}

Specific instructions:
- If the SPEC explicitly asks for something unusual (e.g., "Require 4 exclamation marks"), treat it as correct. Do not override with generic style advice.
- Where possible, use simple numeric/regex checks to verify SPEC (e.g., count '!' on the changed line).
- If there are zero issues, return {"summary": "why it's ok", "issues": []}.

Acceptance Criteria (SPEC):
${input.acceptance || "(none provided)"}

Changed Code (unified diff):
${input.diff}

Review rules:
- Focus on the changed lines in the diff; only step outside for clear adjacent spec/security issues.
- Be precise, actionable, minimal. Use correct line ranges (1-based).
- "blocker" = fails spec/tests/security; "major" = correctness/design; "nit" = style (only if it doesn’t conflict with the SPEC).
`.trim();
}


async function ensureOllamaReady(model: string) {
  const url = 'http://127.0.0.1:11434/api/tags';
  let json: any;
  try {
    const res = await fetch(url);
    json = await res.json();
  } catch {
    throw new Error('Ollama server not reachable at 127.0.0.1:11434. Run `ollama serve`.');
  }
  const hasModel = !!json?.models?.some((m: any) => m.name === model);
  if (!hasModel) {
    throw new Error(`Model "${model}" not found in Ollama. Run: ollama pull ${model}`);
  }
}

async function getReview(opts: { prompt: string; model: string; remoteUrl: string }): Promise<ReviewResult> {
  // Prefer local Ollama unless user configured a remoteUrl proxy
  if (!opts.remoteUrl) {
    await ensureOllamaReady(opts.model);
    const url = 'http://127.0.0.1:11434/api/generate';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: opts.model, prompt: opts.prompt, options: { temperature: 0.0 } }),
    });

    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${await safeText(res)}`);

    // Ollama streams JSON lines; collect them then parse
    const text = await res.text();
    const combined = text.split('\n')
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line).response as string; } catch { return ''; }
      })
      .join('');

    return safeParseReview(combined);
  } else {
    // Simple JSON proxy: expects { summary, issues }
    const res = await fetch(opts.remoteUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: opts.prompt })
    });
    if (!res.ok) throw new Error(`Remote reviewer HTTP ${res.status}: ${await safeText(res)}`);
    const data: any = await res.json();
    return { summary: String(data.summary || ''), issues: (data.issues || []) as ReviewIssue[] };
  }
}

function safeParseReview(modelText: string): { summary: string; issues: ReviewIssue[] } {
  const text = modelText.trim();
  const fence = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : text;

  const objMatch = candidate.match(/\{[\s\S]*\}/);
  const jsonStr = objMatch ? objMatch[0] : candidate;

  try {
    const parsed = JSON.parse(jsonStr);
    const issues = Array.isArray(parsed.issues) ? (parsed.issues as ReviewIssue[]) : [];
    for (const it of issues) {
      it.startLine = Math.max(1, Number(it.startLine) || 1);
      it.endLine   = Math.max(it.startLine, Number(it.endLine) || it.startLine);
      if (!['blocker','major','nit'].includes(it.severity)) it.severity = 'major';
      it.file = String(it.file || '').trim();
      it.file = it.file.replace(/^a\//,'').replace(/^b\//,'').replace(/^\.\/+|^\/+/,'');

    }
    return { summary: String(parsed.summary || ''), issues };
  } catch {
    return { summary: text.slice(0, 800), issues: [] };
  }
}

function filterIssuesAgainstSpec(
  issues: ReviewIssue[],
  acceptance: string,
  fileTextByPath: Map<string, string>
): ReviewIssue[] {
  // Example heuristic: "Require 4 exclamation marks"
  const m = acceptance.match(/require\s+(\d+)\s+exclamation\s*marks?/i);
  if (!m) return issues;

  const required = Number(m[1]);

  return issues.filter(it => {
    const text = fileTextByPath.get(it.file);
    if (!text) return true;
    // Check the first line in the flagged range (simple heuristic)
    const line = text.split('\n')[Math.max(0, it.startLine - 1)] ?? '';
    const count = (line.match(/!/g) || []).length;

    // If SPEC is satisfied and the complaint mentions exclamations, drop it
    if (count === required && /exclamation/i.test(it.message)) return false;
    return true;
  });
}


function publishDiagnostics(issues: ReviewIssue[], workspaceRoot: string) {
  const grouped = new Map<string, ReviewIssue[]>();

  for (const it of issues) {
    const filePath = toAbsolutePath(it.file, workspaceRoot);
    const arr = grouped.get(filePath) || [];
    arr.push({ ...it, file: filePath });
    grouped.set(filePath, arr);
  }

  const entries: [vscode.Uri, vscode.Diagnostic[]][] = [];
  for (const [file, list] of grouped.entries()) {
    const uri = vscode.Uri.file(file);
    const diags = list.map(toDiagnostic);
    entries.push([uri, diags]);
  }

  diagCollection.clear();
  diagCollection.set(entries);
}

function toDiagnostic(it: ReviewIssue): vscode.Diagnostic {
  const start = new vscode.Position(it.startLine - 1, 0);
  const end = new vscode.Position(it.endLine - 1, 1000);
  const sev =
    it.severity === 'blocker' ? vscode.DiagnosticSeverity.Error :
    it.severity === 'major'   ? vscode.DiagnosticSeverity.Warning :
                                vscode.DiagnosticSeverity.Hint;

  const d = new vscode.Diagnostic(new vscode.Range(start, end), it.message, sev);
  d.source = 'AI Reviewer';
  return d;
}

function toAbsolutePath(p: string, workspaceRoot: string): string {
  if (!p) return workspaceRoot;
  let cleaned = p
    .replace(/^a\//, '')
    .replace(/^b\//, '')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, ''); 
  return path.isAbsolute(cleaned) ? cleaned : path.join(workspaceRoot, cleaned);
}

async function resolveToExistingPath(p: string, workspaceRoot: string): Promise<string> {
  let abs = toAbsolutePath(p, workspaceRoot);
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(abs));
    return abs; // exists
  } catch {
    // Try to find by basename anywhere in the workspace (best-effort)
    const base = path.basename(p.replace(/^a\//,'').replace(/^b\//,'').replace(/^\/+|^\.+\//g,''));
    const matches = await vscode.workspace.findFiles(`**/${base}`, '**/node_modules/**', 2);
    if (matches.length) return matches[0].fsPath;
    return abs; // fallback (may still fail)
  }
}

async function showReviewPanel(
  review: { summary: string; issues: ReviewIssue[] },
  workspaceRoot: string
) {
  const panel = vscode.window.createWebviewPanel(
    'aiReviewSummary',
    'AI Review Summary',
    vscode.ViewColumn.Beside,
    { enableScripts: true }
  );

  const items = (review.issues || []).map((it, i) => {
    const badge =
      it.severity === 'blocker' ? '#b00020' :
      it.severity === 'major'   ? '#c77800' :
                                  '#5e6ad2';
    const file = escapeHtml(it.file || '');
    const msg  = escapeHtml(it.message || '');
    const sug  = it.suggestion ? `
      <div style="margin-top:8px">
        <div style="opacity:.7;font-size:12px">Suggestion</div>
        <pre style="white-space:pre-wrap;background:#0001;padding:8px;border-radius:8px">${escapeHtml(it.suggestion)}</pre>
      </div>` : '';

    return `
      <div style="border:1px solid #0002;border-radius:12px;padding:12px;margin:12px 0">
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
          <span style="display:inline-block;background:${badge};color:white;border-radius:999px;padding:2px 8px;font-size:12px;text-transform:uppercase">${escapeHtml(it.severity)}</span>
          <code style="opacity:.9">${file}:${it.startLine}-${it.endLine}</code>
          <button data-i="${i}" style="margin-left:auto;padding:4px 10px;border-radius:8px;border:1px solid #0002;background:#0001;cursor:pointer">Open</button>
        </div>
        <div>${msg}</div>
        ${sug}
      </div>
    `;
  }).join('');

  panel.webview.html = `
    <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; padding:16px; line-height:1.5">
      <h2 style="margin:0 0 8px 0">AI Review</h2>
      <pre style="white-space:pre-wrap;background:#0001;padding:12px;border-radius:12px">${escapeHtml(review.summary || 'No summary')}</pre>
      ${review.issues?.length ? `<h3 style="margin:16px 0 8px">Issues (${review.issues.length})</h3>` : '<p style="opacity:.7;margin-top:12px">No issues reported.</p>'}
      ${items}
      <script>
        const vscode = acquireVsCodeApi();
        const btns = document.querySelectorAll('button[data-i]');
        btns.forEach(b => b.addEventListener('click', () => {
          const i = Number(b.getAttribute('data-i'));
          const it = ${JSON.stringify(review.issues || [])}[i];
          vscode.postMessage({ cmd: 'open', file: it.file, startLine: it.startLine, endLine: it.endLine });
        }));
      </script>
    </div>
  `;

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg?.cmd === 'open') {
      try {
        const abs = await resolveToExistingPath(msg.file, workspaceRoot);
        const uri = vscode.Uri.file(abs);
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc, { preview: false });
        const range = new vscode.Range(Math.max(0, msg.startLine - 1), 0, Math.max(0, msg.endLine - 1), 1000);
        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Could not open ${msg.file}:${msg.startLine}-${msg.endLine} (${e?.message || e})`);
      }
    }
  });
;
}

// ---------- misc ----------

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (m) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[m]!));
}

async function safeText(res: any) {
  try { return await res.text(); } catch { return '<no body>'; }
}
