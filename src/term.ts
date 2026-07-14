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
// because the log is real selectable text, the scroll is the browser's own, and the input is a genuine editable element the keyboard can see.
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
  // Append one line to the log and hand back its node —
  // the node is what the capture loop keeps so it can repaint a marker in place later (see restyle).
  writeLine(text?: string): HTMLElement;
  // Re-render a line's content in place —
  // the DOM-native replacement for the cursor arithmetic the marker repaint used to need.
  restyle(node: HTMLElement, text: string): void;
  // Wipe the log (both /clear and the bare `reset`).
  clear(): void;
  // Fires when Enter is pressed on a normal line (not during a modal readLine).
  onLine(fn: (line: string) => void): void;
  // Fires on Ctrl-C on a normal line.
  onInterrupt(fn: () => void): void;
  // Modal read: show `prompt` on the input line and resolve with the next line entered,
  // or null if it's abandoned with Ctrl-C.
  // The identity flows lean on this to read the email and then the code.
  readLine(prompt: string): Promise<string | null>;
  // Modal multi-select: draw an interactive checklist in the log,
  // and let the symbiot move the cursor with ↑/↓, tick or untick the row under it with space,
  // and settle with Enter — resolving with the final checked-state keyed the way it came in,
  // or null if abandoned (Esc / Ctrl-C).
  // Rows and a save/cancel pair are tappable too, so a touch device with no space bar still works.
  // Like readLine it owns the keyboard for its duration; the input line steps aside and returns after.
  // /notifications leans on this to pick which channels The Joy may reach on.
  checklist(opts: {
    title?: string;
    items: Array<{ key: string; label: string; checked: boolean }>;
  }): Promise<Record<string, boolean> | null>;
  // The inline suggestion provider —
  // given the current line, return the tail to show dim to the right (empty for none).
  // Owned by the app: it knows the verbs.
  setGhost(fn: (line: string) => string): void;
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
  inputLine.append(promptSpan, editable, ghostSpan);

  container.append(log, inputLine);

  // --- state ---------------------------------------------------------------

  const defaultPrompt = opts.prompt;
  let currentPrompt = defaultPrompt;
  let pending: ((line: string | null) => void) | null = null;
  let onLineCb: ((line: string) => void) | null = null;
  let onInterruptCb: (() => void) | null = null;
  let ghostFor: (line: string) => string = () => "";
  // The last message the symbiot clicked — its "you were here" landmark in the wall of text.
  // At most one at a time; clicking another moves it. Cleared when the log is wiped.
  let anchored: HTMLElement | null = null;

  // --- rendering -----------------------------------------------------------

  function scrollToBottom(): void {
    // The container is the scroll region — keep the newest line (and the input
    // that trails it) in view as content grows past the box.
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

  // Mark a log line as the last-clicked landmark, moving the highlight off whatever held it.
  // A no-op if that same line already holds it, so a second tap doesn't flicker.
  function setAnchor(node: HTMLElement): void {
    if (anchored === node) return;
    anchored?.classList.remove("here");
    node.classList.add("here");
    anchored = node;
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
  function echo(line: string, suffix = ""): void {
    const node = document.createElement("div");
    node.className = "line";
    appendStyled(node, currentPrompt);
    node.appendChild(document.createTextNode(line + suffix));
    log.appendChild(node);
    scrollToBottom();
  }

  // --- input ---------------------------------------------------------------

  const getLine = (): string => (editable.textContent ?? "").replace(/\n/g, "");

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

  function updateGhost(): void {
    ghostSpan.textContent = ghostFor(getLine());
  }

  function acceptGhost(): void {
    const ghost = ghostFor(getLine());
    if (!ghost) return;
    editable.textContent = getLine() + ghost;
    setCaretEnd();
    updateGhost();
  }

  function commit(): void {
    const line = getLine();
    echo(line);
    editable.textContent = "";
    updateGhost();
    if (pending) {
      const resolve = pending;
      pending = null;
      setPrompt(defaultPrompt); // the modal read is over — hand the normal prompt back
      resolve(line);
    } else {
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
  // It renders the choices as lines in the log — a cursor, a [x]/[ ] box, the label, the on/off word —
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
          // save and cancel sit side by side, so ←/→ step between them when the cursor is on that row.
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

  // Enter is caught two ways on purpose:
  // keydown for a physical keyboard,
  // and beforeinput's insert-paragraph/line-break for soft keyboards that don't emit a reliable Enter keydown.
  // keydown's preventDefault suppresses the beforeinput,
  // so a normal desktop Return never commits twice.
  editable.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      commit();
    } else if (e.key === "Tab") {
      e.preventDefault();
      acceptGhost();
    } else if (e.key === "ArrowRight") {
      if (caretAtEnd() && ghostFor(getLine())) {
        e.preventDefault();
        acceptGhost();
      }
    } else if (e.ctrlKey && (e.key === "c" || e.key === "C")) {
      // Ctrl-C with a selection is a copy — leave it be; with none, it abandons the line.
      if (window.getSelection()?.isCollapsed !== false) {
        e.preventDefault();
        interrupt();
      }
    }
  });
  editable.addEventListener("beforeinput", (e) => {
    if (e.inputType === "insertParagraph" || e.inputType === "insertLineBreak") {
      e.preventDefault();
      commit();
    }
  });
  editable.addEventListener("input", updateGhost);

  // Tapping anywhere in the terminal focuses the input and drops the caret at the end —
  // so a phone opens its keyboard on a tap —
  // unless text is being selected (leave a selection alone),
  // or the tap landed inside the input already (respect where the caret was placed).
  //
  // A tap that lands on a message line also anchors it as the landmark (see setAnchor):
  // the two compose, so the same tap both opens the keyboard and marks where you were.
  // A drag-select bails at the guard above, so highlighting text to copy never moves the landmark;
  // a blank furniture row (a spacer, a bare marker) carries no text, so it can't become one either.
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
    writeLine,
    restyle,
    clear,
    onLine: (fn) => (onLineCb = fn),
    onInterrupt: (fn) => (onInterruptCb = fn),
    readLine: (prompt) => {
      setPrompt(prompt);
      editable.focus();
      return new Promise((resolve) => (pending = resolve));
    },
    checklist,
    setGhost: (fn) => (ghostFor = fn),
    focus: () => editable.focus(),
  };
}
