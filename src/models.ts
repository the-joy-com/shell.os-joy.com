// The flow behind /models: choose which models The Joy runs, and which one does which job.
//
// This is the shell half of the model-configuration feature. The kernel owns the hard part —
// the durable catalog, the role assignments, the rules about what may be edited (services/memory/model_config.py) —
// so this module only drives the exchange from the terminal: show the current state, read a change, tell the
// kernel, show what it settled on.
//
// It is box-level configuration, not per-symbiot: a model is a property of the machine and the Ollama it can
// reach. But it is still authed-only, and deliberately so — only the operator, having logged in, should see or
// shape which models the box runs. The command is hidden from /help until there's a session (see commands.ts),
// and if it is typed without one anyway, this refuses before reaching the kernel.
//
// The whole reason it exists: a fully-local box points its generative roles at models its own Ollama serves,
// through this command rather than a code change.

import type { AuthIo } from "./auth";
import { type Envelope, KERNEL_MSG } from "./kernel";
import { clearToken, getToken } from "./session";

const dim = (text: string): string => `\x1b[2m${text}\x1b[0m`;
const warn = (text: string): string => `\x1b[33m${text}\x1b[0m`;
const good = (text: string): string => `\x1b[92m${text}\x1b[0m`;

// One model in the catalog — the shape the kernel carries each row back in.
interface ModelRow {
  name: string;
  provider: string;
  optimal_context_tokens: number;
  max_output_tokens: number;
  is_builtin: boolean;
}

// The full model configuration the kernel returns on every /models response.
// reason is present only on a refusal (MODEL_REFUSED), saying why the change didn't take.
interface ModelsData {
  catalog: ModelRow[];
  roles: Record<string, string>;
  assignable_roles: string[];
  reason?: string;
}

// A GET of the current state, or null when it can't be read.
async function readState(kernelUrl: string, token: string): Promise<ModelsData | null> {
  try {
    const res = await fetch(`${kernelUrl}/models`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body: Envelope | null = await res.json().catch(() => null);
    return (body?.data as ModelsData | null) ?? null;
  } catch {
    return null;
  }
}

// A POST of one change. Returns whether the kernel was reached and the parsed envelope it answered with.
async function postChange(
  kernelUrl: string,
  token: string,
  change: Record<string, unknown>,
): Promise<{ reached: boolean; body: Envelope | null }> {
  try {
    const res = await fetch(`${kernelUrl}/models`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(change),
      cache: "no-store",
    });
    return { reached: true, body: res.ok ? await res.json().catch(() => null) : null };
  } catch {
    return { reached: false, body: null };
  }
}

// Print the catalog and the current role assignments — the read-before-write picture, shown before any change
// and again after each one, so the screen is always the kernel's truth rather than what the shell assumed.
function renderState(io: AuthIo, data: ModelsData): void {
  io.print(dim("models the box can talk to:"));
  for (const m of data.catalog) {
    const tag = m.is_builtin ? dim(" (builtin)") : "";
    io.print(
      `  ${m.name}${tag} ${dim(`— ${m.provider}, ${m.optimal_context_tokens} ctx / ${m.max_output_tokens} out`)}`,
    );
  }
  io.print(dim("which model does which job:"));
  for (const role of data.assignable_roles) {
    io.print(`  ${role.padEnd(22)} ${data.roles[role] ?? dim("(unset)")}`);
  }
}

// Report the outcome of one change: a fresh state on success, or the kernel's reason on a refusal.
// A stale session (NOT_AUTHED) drops the dead token, the way the identity flows do.
async function reportChange(
  io: AuthIo,
  reached: boolean,
  body: Envelope | null,
): Promise<void> {
  if (!reached) {
    io.print(dim("couldn't reach the kernel — try again when it's back."));
    return;
  }
  if (body?.msg === KERNEL_MSG.notAuthed) {
    await clearToken();
    io.print(dim("your session expired — /login again, then set your models."));
    return;
  }
  const data = body?.data as ModelsData | null;
  if (body?.msg === KERNEL_MSG.modelRefused) {
    io.print(warn(data?.reason ?? "the kernel turned that change away."));
    if (data) renderState(io, data);
    return;
  }
  if (body?.msg === KERNEL_MSG.models && data) {
    io.print(good("done."));
    renderState(io, data);
    return;
  }
  io.print(warn(body?.msg ?? "the kernel turned that request away — give it a moment."));
}

export async function runModels(kernelUrl: string, io: AuthIo): Promise<void> {
  // Not advertised to visitors, and refused for one who types it anyway —
  // the kernel would turn it away regardless, so we spare the round trip and say why plainly.
  const token = getToken();
  if (!token) {
    io.print(dim("/models needs a session — /login first, then choose your models."));
    return;
  }

  const state = await readState(kernelUrl, token);
  if (state === null) {
    io.print(dim("couldn't read the model configuration — try again when the kernel's back."));
    return;
  }
  renderState(io, state);

  // A small modal loop: one change per pass, until the operator is done (blank line or Ctrl-C).
  // Each pass ends by showing the kernel's fresh state, so several edits read as a running picture.
  for (;;) {
    const verb = await io.readLine(
      dim("change? (assign · add · delete — or blank to finish) "),
    );
    if (verb === null) return; // Ctrl-C — abandon
    const action = verb.trim().toLowerCase();
    if (action === "") return; // blank — done

    if (action === "assign") {
      const role = await io.readLine(`which job? (${state.assignable_roles.join(" · ")}) `);
      if (role === null || !role.trim()) continue;
      const model = await io.readLine("point it at which model? ");
      if (model === null || !model.trim()) continue;
      const { reached, body } = await postChange(kernelUrl, token, {
        action: "assign",
        role: role.trim(),
        model: model.trim(),
      });
      await reportChange(io, reached, body);
    } else if (action === "add") {
      const name = await io.readLine("model name (as Ollama serves it, e.g. qwen3.5:4b) ");
      if (name === null || !name.trim()) continue;
      // Everything past the name is optional — blank takes a sensible local default on the kernel side.
      const provider = await io.readLine(dim("provider? (blank = ollama) "));
      if (provider === null) continue;
      const ctx = await io.readLine(dim("optimal context tokens? (blank = a sensible default) "));
      if (ctx === null) continue;
      const out = await io.readLine(dim("max output tokens? (blank = a sensible default) "));
      if (out === null) continue;
      const change: Record<string, unknown> = { action: "register", name: name.trim() };
      if (provider.trim()) change.provider = provider.trim();
      if (ctx.trim()) change.optimal_context_tokens = Number(ctx.trim());
      if (out.trim()) change.max_output_tokens = Number(out.trim());
      const { reached, body } = await postChange(kernelUrl, token, change);
      await reportChange(io, reached, body);
    } else if (action === "delete") {
      const name = await io.readLine("delete which model? ");
      if (name === null || !name.trim()) continue;
      const { reached, body } = await postChange(kernelUrl, token, {
        action: "delete",
        name: name.trim(),
      });
      await reportChange(io, reached, body);
    } else {
      io.print(dim("didn't catch that — say assign, add, delete, or leave it blank to finish."));
    }
  }
}
