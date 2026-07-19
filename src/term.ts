// The terminal, by hand — plain DOM and CSS, no emulator underneath.
//
// This is what replaced xterm.
// The shell never ran a program that expected a real terminal;
// it only ever needed the *feel* of one —
// a monospaced column of text that scrolls, a prompt, a cursor, a line you type and send.
// xterm gave us that by painting to a canvas and reading keystrokes through a hidden textarea,
// and on a phone both of those fought the browser:
// canvas has no text to select or copy,
// and the hidden textarea reads empty to a soft keyboard, so backspace was swallowed and touch-scroll fought back.
// All three go away here,
// because the log is real selectable text,
// the scroll is the browser's own,
// and the input is a genuine editable element the keyboard can see.
//
// The division of labour:
// this module owns the surface (the scrolling log and the input line) and the raw key handling;
// the app above it owns *what a line means* —
// it hands us a line handler, a ghost-suggestion function, and the prompt string,
// and never touches the DOM itself.

// The colour vocabulary the shell emits, as ANSI SGR codes, mapped to CSS classes.
// The rest of the codebase still writes `\x1b[92m…\x1b[0m` and friends
// — those are the shell's styling language —
// and this is the one place that turns them into styled spans,
// so no caller had to change how it colours text.
const SGR = /\x1b\[([0-9;]*)m/g;
const CODE_CLASS: Record<string, string> = {
  "1": "b", // bold
  "2": "dim", // dim
  "31": "red",
  "32": "green",
  "33": "yellow",
  "92": "bgreen", // bright green
};

// Parse the small SGR subset the shell uses and append the text as styled spans
// (plain text nodes where no style is active).
// `\x1b[0m` — or a bare `\x1b[m` — resets.
// Carriage returns are dropped; newlines survive and render as breaks,
// because the log lines are `white-space: pre-wrap`.
function appendStyled(parent: HTMLElement, text: string): void {
  let active: string[] = [];
  const emit = (chunk: string): void => {
    if (!chunk) return;
    if (active.length === 0) {
      parent.appendChild(document.createTextNode(chunk));
      return;
    }
    const span = document.createElement("span");
    span.className = active.join(" ");
    span.textContent = chunk;
    parent.appendChild(span);
  };
  const clean = text.replace(/\r/g, "");
  let last = 0;
  SGR.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SGR.exec(clean)) !== null) {
    emit(clean.slice(last, m.index));
    last = SGR.lastIndex;
    const codes = m[1] === "" ? ["0"] : m[1].split(";");
    for (const c of codes) {
      if (c === "0" || c === "") active = [];
      else if (CODE_CLASS[c]) active = [...active.filter((x) => x !== CODE_CLASS[c]), CODE_CLASS[c]];
    }
  }
  emit(clean.slice(last));
}

export interface Term {
  // Wipe the log (both /clear and the bare `reset`).
  clear(): void;
  // Re-render a line's content in place —
  // the DOM-native replacement for the cursor arithmetic the marker repaint used to need.
  restyle(node: HTMLElement, text: string): void;
  // Append one line to the log and hand back its node —
  // the node is what the capture loop keeps so it can repaint a marker in place later (see restyle).
  writeLine(text?: string): HTMLElement;
  // Tag a log line as a replyable message, stashing the text to quote when replying to it.
  // A message so tagged offers a `↩ reply` control once it's the tapped landmark (see setAnchor);
  // the shell marks Joy's answers and the symbiot's own sent thoughts, and nothing else.
  markMessage(node: HTMLElement, quote: string): void;
  // Fires on Ctrl-C on a normal line.
  onInterrupt(fn: () => void): void;
  // Fires when a normal line is sent (not during a modal readLine).
  onLine(fn: (line: string) => void): void;
  // Modal card picker: draw a column of bordered cards in the log,
  // each loading its own summary behind an in-card spinner,
  // and let the symbiot move between them with ↑/↓ and open one with Enter (or a tap),
  // resolving with the chosen card's key, or null if abandoned (Esc / Ctrl-C).
  // Each card's `load` runs the moment the picker opens, independently —
  // a slow or failed card never holds the others:
  // its resolved text fills that card in place,
  // a rejection leaves a quiet error line in it alone.
  // Like readLine and checklist it owns the keyboard for its duration;
  // the input line steps aside and returns after.
  // /observe leans on this for its hub of observability lenses.
  cards(opts: {
    title?: string;
    items: Array<{ key: string; title: string; description: string; load: () => Promise<string> }>;
  }): Promise<string | null>;
  // Modal multi-select: draw an interactive checklist in the log,
  // and let the symbiot move the cursor with ↑/↓, tick or untick the row under it with space,
  // and settle with Enter — resolving with the final checked-state keyed the way it came in,
  // or null if abandoned (Esc / Ctrl-C).
  // Rows and a save/cancel pair are tappable too,
  // so a touch device with no space bar still works.
  // Like readLine it owns the keyboard for its duration;
  // the input line steps aside and returns after.
  // /notifications leans on this to pick which channels The Joy may reach on.
  checklist(opts: {
    title?: string;
    items: Array<{ key: string; label: string; checked: boolean }>;
  }): Promise<Record<string, boolean> | null>;
  // Modal read: show `prompt` on the input line and resolve with the next line entered,
  // or null if it's abandoned with Ctrl-C.
  // The identity flows lean on this to read the email and then the code.
  readLine(prompt: string): Promise<string | null>;
  // The inline suggestion provider —
  // given the current line, return the tail to show dim to the right (empty for none).
  // Owned by the app: it knows the verbs.
  setGhost(fn: (line: string) => string): void;
  // Whether the current line sends on Enter rather than taking a line break —
  // true for a command (a slash verb, a bare keyword),
  // false for prose that submits via the send control.
  // Owned by the app for the same reason as the ghost: only it knows what a command is.
  setSendsOnEnter(fn: (line: string) => boolean): void;
  // Put focus back on the input (used after a modal flow settles).
  focus(): void;
}

export function createTerminal(container: HTMLElement, opts: { prompt: string }): Term {
  container.classList.add("term");

  const log = document.createElement("div");
  log.className = "term-log";

  const inputLine = document.createElement("div");
  inputLine.className = "term-input";
  const promptSpan = document.createElement("span");
  promptSpan.className = "prompt";
  const editable = document.createElement("span");
  editable.className = "editable";
  editable.setAttribute("contenteditable", "plaintext-only");
  editable.setAttribute("spellcheck", "false");
  editable.setAttribute("autocapitalize", "off");
  editable.setAttribute("autocorrect", "off");
  const ghostSpan = document.createElement("span");
  ghostSpan.className = "ghost";
  // The send control: submission moved here so Enter is free to make line breaks.
  // Quiet furniture in the terminal's own vocabulary (the checklist's [ save ] lives in the same key),
  // pinned to the right edge of the input line by CSS rather than by its place in this flow.
  const sendBtn = document.createElement("span");
  sendBtn.className = "term-send";
  sendBtn.textContent = "send";
  sendBtn.setAttribute("role", "button");
  sendBtn.setAttribute("aria-label", "send");
  // A native tooltip points at the keyboard path without adding chrome —
  // the hover hint stays out of the terminal's own surface until asked for.
  sendBtn.title = "send — or press Shift+Enter";
  sendBtn.hidden = true; // nothing to send on a blank line — the control appears once there's content
  inputLine.append(promptSpan, editable, ghostSpan, sendBtn);

  container.append(log, inputLine);

  // --- state ---------------------------------------------------------------

  const defaultPrompt = opts.prompt;
  let currentPrompt = defaultPrompt;
  let pending: ((line: string | null) => void) | null = null;
  let onLineCb: ((line: string) => void) | null = null;
  let onInterruptCb: (() => void) | null = null;
  let ghostFor: (line: string) => string = () => "";
  // Default until the app wires its own:
  // the slash convention alone, so a terminal used bare still sends commands.
  let sendsOnEnter: (line: string) => boolean = (line) => line.startsWith("/");
  // The last message the symbiot clicked — its "you were here" landmark in the wall of text,
  // and the line the `↩ reply` control rides while it's the one anchored (see setAnchor).
  // At most one at a time; clicking another moves it. Cleared when the log is wiped.
  let anchored: HTMLElement | null = null;
  // Command history for arrow up/down navigation
  const history: string[] = [];
  let historyIndex = -1;
  let tempInput = ""; // Store current input when navigating history

  // --- rendering -----------------------------------------------------------

  function scrollToBottom(): void {
    // The container is the scroll region —
    // keep the newest line (and the input that trails it) in view as content grows past the box.
    container.scrollTop = container.scrollHeight;
  }

  function writeLine(text = ""): HTMLElement {
    const node = document.createElement("div");
    node.className = "line";
    if (text) appendStyled(node, text);
    log.appendChild(node);
    scrollToBottom();
    return node;
  }

  function restyle(node: HTMLElement, text: string): void {
    node.textContent = "";
    appendStyled(node, text);
  }

  function clear(): void {
    log.textContent = "";
    anchored = null; // the landmark's node is gone with the log — forget it, don't dangle
  }

  // The reply control that rides the anchored message:
  // a quiet `↩ reply` at the line's end,
  // shown only while a message is the tapped landmark — so it costs nothing on every other line.
  // Clicking it seeds the input with the message quoted and a clear rule beneath, caret below,
  // for the symbiot to type the reply and send the whole block as one message (see seedReply).
  // One element, moved between lines as the landmark moves (see setAnchor), never one per line.
  const replyBtn = document.createElement("span");
  replyBtn.className = "term-reply";
  replyBtn.textContent = "↩ reply";
  replyBtn.setAttribute("role", "button");
  replyBtn.setAttribute("aria-label", "reply");
  replyBtn.title = "reply — quote this message";
  // mousedown swallowed so a tap never blurs the editable first (keeps a phone's keyboard up);
  // the click seeds the reply and stops there, so the container's tap-to-anchor doesn't re-fire.
  replyBtn.addEventListener("mousedown", (e) => e.preventDefault());
  replyBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    seedReply(anchored?.dataset.msg ?? "");
  });

  // Tag a log line as a replyable message, stashing the body to quote — the sigil-free text,
  // so a reply quotes what was said, not the `❮ joy` / `joy ❯` furniture around it.
  // If the line is already the landmark, reveal its reply control at once.
  function markMessage(node: HTMLElement, quote: string): void {
    node.classList.add("msg");
    node.dataset.msg = quote;
    if (anchored === node) node.appendChild(replyBtn);
  }

  // Seed the input with a reply to `quote`:
  // each quoted line prefixed with `> `, a `---` rule,
  // then the caret on an empty line below, where the reply is typed.
  // The block is prose (it doesn't start with `/`),
  // so Enter keeps making line breaks
  // and the send control commits the whole thing — quote, rule, and reply —
  // as one message to the kernel.
  function seedReply(quote: string): void {
    const quoted = quote
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n");
    editable.textContent = `${quoted}\n---\n`;
    setCaretEnd();
    updateGhost();
    editable.focus();
  }

  // Mark a log line as the last-clicked landmark, moving the highlight off whatever held it.
  // A no-op if that same line already holds it, so a second tap doesn't flicker.
  // The reply control travels with the landmark:
  // it comes off the line losing it,
  // and lands on the new one only if that's a message —
  // plain furniture (a marker, a help line) carries none.
  function setAnchor(node: HTMLElement): void {
    if (anchored === node) return;
    anchored?.classList.remove("here");
    replyBtn.remove();
    node.classList.add("here");
    anchored = node;
    if (node.classList.contains("msg")) node.appendChild(replyBtn);
  }

  function setPrompt(raw: string): void {
    currentPrompt = raw;
    promptSpan.textContent = "";
    appendStyled(promptSpan, raw);
  }
  setPrompt(defaultPrompt);

  // Echo the just-entered line into the log, using whatever prompt is showing now
  // (the default, or a modal "email: "),
  // so what was typed stays on screen above its answer —
  // the same record xterm kept by echoing inline as you typed.
  function echo(line: string, suffix = ""): HTMLElement {
    const node = document.createElement("div");
    // `you` marks the line as the symbiot's own,
    // so it reads dimmer than The Joy's replies (see style.css):
    // what you typed recedes, the answer coming back stands out.
    // Joy's lines go through writeLine and stay bare.
    node.className = "line you";
    appendStyled(node, currentPrompt);
    node.appendChild(document.createTextNode(line + suffix));
    log.appendChild(node);
    scrollToBottom();
    return node;
  }

  // --- input ---------------------------------------------------------------

  // Newlines are content now (Enter inserts them), so they survive to the sent line;
  // only a trailing run is shed at commit,
  // so a stray Enter before send doesn't tack on a blank row.
  const getLine = (): string => editable.textContent ?? "";

  function setCaretEnd(): void {
    const range = document.createRange();
    range.selectNodeContents(editable);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  function caretAtEnd(): boolean {
    const line = getLine();
    if (line === "") return true;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    return editable.contains(range.endContainer) && range.endOffset === (range.endContainer.textContent?.length ?? 0);
  }

  // The send control only shows when there's something to send:
  // a blank line — empty, or only whitespace and newlines — has nothing to commit, so the affordance stays hidden.
  function syncSend(): void {
    sendBtn.hidden = getLine().trim() === "";
  }

  function updateGhost(): void {
    ghostSpan.textContent = ghostFor(getLine());
    syncSend();
  }

  function acceptGhost(): void {
    const ghost = ghostFor(getLine());
    if (!ghost) return;
    editable.textContent = getLine() + ghost;
    setCaretEnd();
    updateGhost();
  }

  function commit(): void {
    const line = getLine().replace(/^\n+|\n+$/g, "");
    const node = echo(line);
    editable.textContent = "";
    updateGhost();
    // Reset history navigation state when committing
    historyIndex = -1;
    tempInput = "";
    // Add non-empty input to history
    if (line !== "") {
      history.push(line);
    }
    if (pending) {
      const resolve = pending;
      pending = null;
      setPrompt(defaultPrompt); // the modal read is over — hand the normal prompt back
      resolve(line);
    } else {
      // A sent thought is a message the symbiot can later reply to;
      // a command (a slash verb or a bare keyword) and a blank line are not,
      // so only prose is marked.
      // sendsOnEnter is the app's own command test,
      // so this leans on it rather than re-deciding what counts as a command.
      if (line !== "" && !sendsOnEnter(line)) markMessage(node, line);
      onLineCb?.(line);
    }
  }

  function interrupt(): void {
    echo(getLine(), "^C");
    editable.textContent = "";
    updateGhost();
    if (pending) {
      const resolve = pending;
      pending = null;
      setPrompt(defaultPrompt);
      resolve(null);
    } else {
      onInterruptCb?.();
    }
  }

  // A modal checklist: the read-a-line sibling for the times the answer is a set of on/off choices,
  // rather than typed text (today, which channels /notifications may reach on).
  // It renders the choices as lines in the log —
  // a cursor, a [x]/[ ] box, the label, the on/off word —
  // and takes the keyboard for its duration the way readLine does,
  // then hands the input line back and resolves.
  //
  // Two ways in, so neither a keyboard nor a touch screen is left out:
  // ↑/↓ move the cursor and space acts on the row under it, or a tap acts on a row directly.
  // The cursor walks the channel rows and then the save / cancel buttons, one navigable strip —
  // on a channel row space toggles it, on a button space activates it.
  // Enter settles (saving, unless the cursor is resting on cancel), Esc / Ctrl-C abandons.
  // The block is left frozen in the log as a record of what was chosen.
  function checklist(opts: {
    title?: string;
    items: Array<{ key: string; label: string; checked: boolean }>;
  }): Promise<Record<string, boolean> | null> {
    const { items } = opts;
    const checked: Record<string, boolean> = {};
    for (const it of items) checked[it.key] = it.checked;
    let cursor = 0;

    // The input line steps aside and loses its focus,
    // so a stray keystroke can't leak into it while the checklist owns the keyboard
    // (a hidden-but-focused editable would still catch Enter).
    inputLine.style.display = "none";
    editable.blur();

    if (opts.title) writeLine(`\x1b[2m${opts.title}\x1b[0m`);
    const width = Math.max(...items.map((it) => it.label.length), 0);

    // One row's text at its current state.
    // The label is padded before any colour so the on/off column lines up;
    // the cursor row alone is marked and bolded, and a settled block (cursor gone) reads plain.
    const rowText = (i: number): string => {
      const it = items[i];
      const cur = i === cursor;
      const marker = cur ? "\x1b[92m❯\x1b[0m" : " ";
      const box = checked[it.key] ? "\x1b[92m[x]\x1b[0m" : "[ ]";
      const label = cur ? `\x1b[1m${it.label.padEnd(width)}\x1b[0m` : it.label.padEnd(width);
      const state = checked[it.key] ? "\x1b[92mon\x1b[0m" : "\x1b[2moff\x1b[0m";
      return `${marker} ${box} ${label}  ${state}`;
    };

    // The cursor walks one strip: the channel rows first, then save, then cancel.
    // So two positions past the last item name the buttons.
    const saveRow = items.length;
    const cancelRow = items.length + 1;
    const total = items.length + 2;

    return new Promise((resolve) => {
      const itemNodes = items.map((_, i) => writeLine(rowText(i)));

      // Tapping a row toggles it and moves the cursor there — a touch device has no space bar.
      itemNodes.forEach((node, i) => {
        node.classList.add("choice");
        node.addEventListener("click", (e) => {
          e.stopPropagation();
          cursor = i;
          checked[items[i].key] = !checked[items[i].key];
          repaint();
        });
      });

      // A save / cancel pair, tappable for pointers and reachable by the cursor for the keyboard.
      // Built once with their own spans (their click handlers must survive repaints),
      // so the focus state is painted by mutating them in place rather than rebuilding them,
      // and they're left in the log frozen alongside the rows.
      const controls = writeLine();
      const saveBtn = document.createElement("span");
      saveBtn.className = "choice bgreen";
      const cancelBtn = document.createElement("span");
      cancelBtn.className = "choice dim";
      controls.append(saveBtn, cancelBtn);

      // The focused button carries the same ❯ the rows use and goes bold;
      // a 2-space slot holds the marker's place so nothing shifts as focus moves,
      // and cancel sheds its dim while focused so the highlight reads clearly.
      // With the cursor cleared (the settled block), neither is focused and both read plain.
      const paintButtons = (): void => {
        const onSave = cursor === saveRow;
        const onCancel = cursor === cancelRow;
        saveBtn.textContent = `${onSave ? "❯ " : "  "}[ save ]`;
        saveBtn.classList.toggle("b", onSave);
        cancelBtn.textContent = `${onCancel ? "  ❯ " : "    "}[ cancel ]`;
        cancelBtn.classList.toggle("b", onCancel);
        cancelBtn.classList.toggle("dim", !onCancel);
      };

      const repaint = (): void => {
        itemNodes.forEach((node, i) => restyle(node, rowText(i)));
        paintButtons();
      };
      paintButtons(); // set the resting text before the first keystroke

      writeLine("\x1b[2m↑/↓ move · space toggles · enter saves · esc cancels\x1b[0m");

      const settle = (result: Record<string, boolean> | null): void => {
        window.removeEventListener("keydown", onKey, true);
        cursor = -1; // clear the highlight so the frozen block reads as a plain record
        repaint();
        inputLine.style.display = "";
        editable.focus();
        resolve(result);
      };

      // Handled in the capture phase so the choice keys never reach anything below,
      // and with the arrows and space prevented from scrolling the page under the terminal.
      const onKey = (e: KeyboardEvent): void => {
        if (e.key === "ArrowDown" || e.key === "j") {
          cursor = (cursor + 1) % total;
          repaint();
        } else if (e.key === "ArrowUp" || e.key === "k") {
          cursor = (cursor - 1 + total) % total;
          repaint();
        } else if (e.key === "ArrowRight" || e.key === "l") {
          // save and cancel sit side by side,
          // so ←/→ step between them when the cursor is on that row.
          if (cursor === saveRow) {
            cursor = cancelRow;
            repaint();
          } else return;
        } else if (e.key === "ArrowLeft" || e.key === "h") {
          if (cursor === cancelRow) {
            cursor = saveRow;
            repaint();
          } else return;
        } else if (e.key === " " || e.key === "x") {
          // Space acts on the row under the cursor: a channel toggles, a button fires.
          if (cursor === saveRow) settle({ ...checked });
          else if (cursor === cancelRow) settle(null);
          else {
            checked[items[cursor].key] = !checked[items[cursor].key];
            repaint();
          }
        } else if (e.key === "Enter") {
          // Enter settles — saving, unless the cursor is resting on cancel.
          settle(cursor === cancelRow ? null : { ...checked });
        } else if (e.key === "Escape" || (e.ctrlKey && (e.key === "c" || e.key === "C"))) {
          settle(null);
        } else {
          return; // an unhandled key falls through untouched
        }
        e.preventDefault();
        e.stopPropagation();
      };

      saveBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        settle({ ...checked });
      });
      cancelBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        settle(null);
      });

      window.addEventListener("keydown", onKey, true);
    });
  }

  // A modal card picker: the checklist's sibling for the times the answer is "which one", not "which subset".
  // It draws each choice as a bordered card —
  // a title on the top rule, a description, and a summary line —
  // and runs each card's `load` the moment it opens, independently,
  // so a slow or failed card never holds the rest:
  // the summary line spins until that card's own load settles,
  // then fills with its text in place (or a quiet error line, in that card alone).
  // It owns the keyboard the way readLine and checklist do —
  // ↑/↓ move the focus, Enter opens the focused card, Esc / Ctrl-C abandons —
  // and a tap opens a card directly.
  // The block is left frozen in the log as a record of what was on offer.
  function cards(opts: {
    title?: string;
    items: Array<{ key: string; title: string; description: string; load: () => Promise<string> }>;
  }): Promise<string | null> {
    const { items } = opts;
    let cursor = 0;
    let done = false;

    // The input line steps aside and drops focus,
    // so a keystroke can't leak into it while the picker owns the keyboard.
    inputLine.style.display = "none";
    editable.blur();

    if (opts.title) writeLine(`\x1b[2m${opts.title}\x1b[0m`);

    const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    // One inner width for every card, so the column reads as a set:
    // wide enough for the widest title or description,
    // and never narrower than a comfortable minimum.
    const contentW = Math.max(28, ...items.map((it) => it.title.length), ...items.map((it) => it.description.length));
    const W = contentW + 2; // the border run between the corners — one padding space each side of the content
    const dashes = "─".repeat(W);
    const truncate = (s: string): string => (s.length <= contentW ? s : `${s.slice(0, contentW - 1)}…`);

    // Per-card display state: the summary line's current text, and whether that card is still loading (for the spinner).
    const summary = items.map(() => "loading…");
    const loading = items.map(() => true);

    return new Promise((resolve) => {
      // Each card is four held log lines: the titled top rule, the description, the summary, the bottom rule.
      const nodes = items.map(() => ({
        top: writeLine(),
        desc: writeLine(),
        sum: writeLine(),
        bottom: writeLine(),
      }));

      // A focused card wears the bright border; the rest rest dim.
      // The description is always dim;
      // the summary is dim while loading (so the spinner reads as pending)
      // and plain once its text has landed.
      const paintCard = (i: number): void => {
        const it = items[i];
        const b = i === cursor ? "\x1b[92m" : "\x1b[2m";
        const titleFill = "─".repeat(Math.max(0, W - it.title.length - 2));
        restyle(nodes[i].top, `${b}┌ ${it.title} ${titleFill}┐\x1b[0m`);
        restyle(nodes[i].desc, `${b}│\x1b[0m \x1b[2m${truncate(it.description).padEnd(contentW)}\x1b[0m ${b}│\x1b[0m`);
        const body = truncate(summary[i]).padEnd(contentW);
        restyle(nodes[i].sum, `${b}│\x1b[0m ${loading[i] ? `\x1b[2m${body}\x1b[0m` : body} ${b}│\x1b[0m`);
        restyle(nodes[i].bottom, `${b}└${dashes}┘\x1b[0m`);
      };
      const repaintAll = (): void => items.forEach((_, i) => paintCard(i));

      // One ticker spins every card still loading; it's cleared the moment the picker settles.
      let frame = 0;
      const spin = window.setInterval(() => {
        frame = (frame + 1) % SPINNER.length;
        for (let i = 0; i < items.length; i++) {
          if (loading[i]) {
            summary[i] = `${SPINNER[frame]} loading…`;
            paintCard(i);
          }
        }
      }, 90);

      // Each card's own load, kicked off at once and settled independently —
      // one card's failure or slowness fills only its own summary,
      // never blocking the others or the hub.
      items.forEach((it, i) => {
        void it.load().then(
          (text) => {
            loading[i] = false;
            summary[i] = text;
            paintCard(i);
          },
          () => {
            loading[i] = false;
            summary[i] = "— couldn't load —";
            paintCard(i);
          },
        );
      });

      repaintAll();
      writeLine("\x1b[2m↑/↓ move · enter opens · esc leaves\x1b[0m");

      const settle = (result: string | null): void => {
        if (done) return;
        done = true;
        window.removeEventListener("keydown", onKey, true);
        window.clearInterval(spin);
        cursor = -1; // clear the focus highlight so the frozen block reads as a plain record
        repaintAll();
        inputLine.style.display = "";
        editable.focus();
        resolve(result);
      };

      // Tapping any line of a card opens it — a touch device has no Enter within reach either.
      nodes.forEach((card, i) => {
        for (const node of [card.top, card.desc, card.sum, card.bottom]) {
          node.classList.add("choice");
          node.addEventListener("click", (e) => {
            e.stopPropagation();
            settle(items[i].key);
          });
        }
      });

      // Handled in the capture phase so the navigation keys never reach anything below,
      // with the arrows prevented from scrolling the page under the terminal.
      const onKey = (e: KeyboardEvent): void => {
        if (e.key === "ArrowDown" || e.key === "j") {
          cursor = (cursor + 1) % items.length;
          repaintAll();
        } else if (e.key === "ArrowUp" || e.key === "k") {
          cursor = (cursor - 1 + items.length) % items.length;
          repaintAll();
        } else if (e.key === "Enter") {
          settle(items[cursor].key);
        } else if (e.key === "Escape" || (e.ctrlKey && (e.key === "c" || e.key === "C"))) {
          settle(null);
        } else {
          return; // an unhandled key falls through untouched
        }
        e.preventDefault();
        e.stopPropagation();
      };

      window.addEventListener("keydown", onKey, true);
    });
  }

  // Enter no longer sends *content*:
  // it inserts a line break, so a multi-line thought can be shaped as it reads.
  // The one exception is a slash command —
  // a single-line instruction to the shell, never prose —
  // which Enter still sends,
  // so a command needn't reach for the send control the way a thought does.
  // The editable is plaintext-only,
  // so for ordinary content the browser inserts the newline on its own —
  // Enter is left unhandled below,
  // and a desktop keydown and a soft keyboard's beforeinput both fall through to that default.
  // Tab and ArrowRight still accept the ghost,
  // Ctrl-C still abandons the line,
  // and content submission moved to the send control below.
  editable.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      acceptGhost();
    } else if (e.key === "ArrowRight") {
      if (caretAtEnd() && ghostFor(getLine())) {
        e.preventDefault();
        acceptGhost();
      }
    } else if (e.key === "ArrowUp") {
      // Navigate up through command history
      if (history.length > 0) {
        e.preventDefault();
        if (historyIndex === -1) {
          // Save current input before navigating
          tempInput = getLine();
          historyIndex = history.length - 1;
        } else if (historyIndex > 0) {
          historyIndex--;
        }
        editable.textContent = history[historyIndex];
        setCaretEnd();
        updateGhost();
      }
    } else if (e.key === "ArrowDown") {
      // Navigate down through command history
      if (history.length > 0 && historyIndex !== -1) {
        e.preventDefault();
        if (historyIndex < history.length - 1) {
          historyIndex++;
          editable.textContent = history[historyIndex];
        } else {
          // Reached the end, restore the temp input
          historyIndex = -1;
          editable.textContent = tempInput;
        }
        setCaretEnd();
        updateGhost();
      }
    } else if (e.key === "Enter" && e.shiftKey) {
      // Shift-Enter always sends, command or thought alike —
      // the keyboard shortcut for the send control,
      // so a thought can leave without a reach for the mouse while plain Enter keeps making line breaks.
      e.preventDefault();
      commit();
    } else if (e.key === "Enter" && sendsOnEnter(getLine())) {
      // A command sends on Enter, so it needn't reach for the send control the way a thought does.
      // What counts as a command is the app's to know (a slash verb, a bare keyword like `reset`) —
      // the terminal only asks, through the predicate the app injects (setSendsOnEnter).
      e.preventDefault();
      commit();
    } else if (e.ctrlKey && (e.key === "c" || e.key === "C")) {
      // Ctrl-C with a selection is a copy — leave it be; with none, it abandons the line.
      if (window.getSelection()?.isCollapsed !== false) {
        e.preventDefault();
        interrupt();
      }
    }
  });
  editable.addEventListener("input", updateGhost);

  // Submission lives on the send control now that Enter makes line breaks.
  // mousedown is swallowed so a tap never blurs the editable first,
  // which keeps a phone's keyboard up across the send;
  // the click commits the line and hands focus back for the next one.
  sendBtn.addEventListener("mousedown", (e) => e.preventDefault());
  sendBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    commit();
    editable.focus();
  });

  // Tapping anywhere in the terminal focuses the input and drops the caret at the end —
  // so a phone opens its keyboard on a tap —
  // unless text is being selected (leave a selection alone),
  // or the tap landed inside the input already (respect where the caret was placed).
  //
  // A tap that lands on a message line also anchors it as the landmark (see setAnchor):
  // the two compose, so the same tap both opens the keyboard and marks where you were.
  // A drag-select bails at the guard above,
  // so highlighting text to copy never moves the landmark;
  // a blank furniture row (a spacer, a bare marker) carries no text,
  // so it can't become one either.
  container.addEventListener("click", (e) => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    if (e.target instanceof Node && editable.contains(e.target)) return;
    const el = e.target instanceof Element ? e.target : (e.target as Node | null)?.parentElement;
    const line = el?.closest<HTMLElement>(".line");
    if (line && log.contains(line) && (line.textContent ?? "").trim() !== "") setAnchor(line);
    editable.focus();
    setCaretEnd();
  });

  editable.focus();

  return {
    clear,
    restyle,
    writeLine,
    markMessage,
    onInterrupt: (fn) => (onInterruptCb = fn),
    onLine: (fn) => (onLineCb = fn),
    cards,
    checklist,
    readLine: (prompt) => {
      setPrompt(prompt);
      editable.focus();
      return new Promise((resolve) => (pending = resolve));
    },
    setGhost: (fn) => (ghostFor = fn),
    setSendsOnEnter: (fn) => (sendsOnEnter = fn),
    focus: () => editable.focus(),
  };
}
