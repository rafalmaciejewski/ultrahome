import { styleText } from 'node:util';
import { printable } from './report.mjs';

const FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const BAR = 24;
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

// Shows how the clones of `entries` progress. In a terminal, it redraws the
// running clones under an overall bar. Elsewhere, such as in CI or a log, it
// prints a line as each clone starts and finishes.
export function cloneProgress(entries, stream = process.stdout) {
  return stream.isTTY && process.env.TERM !== 'dumb'
    ? new LiveProgress(entries, stream)
    : new LineProgress(stream);
}

class LineProgress {
  constructor(stream) {
    this.stream = stream;
  }

  start(entry) {
    this.stream.write(`Cloning ${entry}...\n`);
  }

  update() {}

  finish(entry, cloned) {
    if (cloned) this.stream.write(`Cloned ${entry}\n`);
  }

  stop() {}
}

// What a clone is doing, such as "Receiving objects 42%, 1.20 MiB | 3.10
// MiB/s". The details come from the remote, so control characters are
// escaped.
function describe({ phase, percent, detail } = {}) {
  if (!phase) return 'Connecting';
  const share = percent === undefined ? '' : ` ${percent}%`;
  return printable(`${phase}${share}${detail ? `, ${detail}` : ''}`);
}

export class LiveProgress {
  constructor(entries, stream) {
    this.stream = stream;
    this.total = entries.length;
    this.done = 0;
    this.running = new Map();
    this.nameWidth = Math.min(20, Math.max(...entries.map((e) => e.length)));
    this.frame = 0;
    // The number of lines drawn below the log, which the next draw replaces.
    this.height = 0;
    // A forced exit skips stop(), so the cursor comes back here.
    this.restore = () => stream.write(SHOW_CURSOR);
    process.on('exit', this.restore);
    stream.write(HIDE_CURSOR);
    this.timer = setInterval(() => this.draw(), 80);
  }

  start(entry) {
    this.running.set(entry, {});
    this.draw();
  }

  update(entry, status) {
    this.running.set(entry, status);
  }

  // Counts a finished clone, and logs it above the live lines once it
  // succeeds. Failures are reported at the end.
  finish(entry, cloned) {
    this.running.delete(entry);
    this.done++;
    this.draw(cloned ? `Cloned ${entry}\n` : '');
  }

  stop() {
    clearInterval(this.timer);
    this.stream.write(this.erase() + SHOW_CURSOR);
    process.off('exit', this.restore);
  }

  // Moves to the first live line and clears from there down.
  erase() {
    const up = this.height ? `\x1b[${this.height}A` : '';
    this.height = 0;
    return `\r${up}\x1b[J`;
  }

  // Redraws the live lines, after `log` if given, in one write so they don't
  // flicker.
  draw(log = '') {
    const lines = this.lines();
    this.stream.write(this.erase() + log + lines.map((l) => l + '\n').join(''));
    this.height = lines.length;
  }

  lines() {
    if (!this.running.size) return [];
    const width = (this.stream.columns || 80) - 1;
    const spinner = FRAMES[this.frame++ % FRAMES.length];
    const partial = [...this.running.values()].reduce(
      (sum, status) => sum + (status.fraction ?? 0),
      0,
    );
    const filled = Math.round(((this.done + partial) / this.total) * BAR);
    const bar = [
      ['━'.repeat(filled), 'cyan'],
      ['─'.repeat(BAR - filled), 'dim'],
    ];
    // A single clone fits on one line.
    if (this.total === 1) {
      const [[entry, status]] = this.running;
      return [
        this.fit(width, [
          [`${spinner} `, 'cyan'],
          [`Cloning ${entry} `],
          ...bar,
          [`  ${describe(status)}`, 'dim'],
        ]),
      ];
    }
    const header = this.fit(width, [
      [`${spinner} `, 'cyan'],
      ['Cloning projects '],
      ...bar,
      [` ${this.done}/${this.total}`],
    ]);
    const column = this.nameWidth;
    const rows = [...this.running].map(([entry, status]) => {
      const name =
        entry.length > column
          ? entry.slice(0, column - 1) + '…'
          : entry.padEnd(column);
      return this.fit(width, [[`  ${name}  `], [describe(status), 'dim']]);
    });
    return [header, ...rows];
  }

  // Joins styled `parts` into one line of at most `width` columns, so no
  // line wraps and the next draw knows how far up to go.
  fit(width, parts) {
    let room = width;
    let line = '';
    for (const [text, style] of parts) {
      const shown =
        text.length <= room ? text : text.slice(0, Math.max(room - 1, 0)) + '…';
      room -= shown.length;
      line += style ? styleText(style, shown, { stream: this.stream }) : shown;
      if (room <= 0) break;
    }
    return line;
  }
}
