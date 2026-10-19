export function resolveCommand(left, right) {
  if (left === 'open' && right === 'open') return 'forward';
  if (left === 'fist' && right === 'open') return 'right';
  if (left === 'open' && right === 'fist') return 'left';
  if (left === 'fist' && right === 'fist') return 'backward';
  return 'stop';
}

export class CommandSender {
  constructor(write, onSent = () => {}, onError = () => {}) {
    Object.assign(this, {write, onSent, onError, desired: null, last: null, stopPending: false, busy: false, closed: false, retryAt: 0});
  }
  request(command) {
    if (this.closed) return;
    this.desired = command;
    if (command === 'stop' && (this.busy || this.last !== 'stop')) this.stopPending = true;
    void this.flush();
  }
  close() { this.closed = true; }
  async flush() {
    if (this.busy || this.closed || Date.now() < this.retryAt) return;
    this.busy = true;
    try {
      while (!this.closed && (this.stopPending || this.desired !== this.last)) {
        const command = this.stopPending ? 'stop' : this.desired;
        this.stopPending = false;
        try {
          await this.write(command);
          if (this.closed) break;
          this.last = command;
          if (command === 'stop') this.stopPending = false;
          this.onSent(command);
        } catch (error) {
          if (this.closed) break;
          if (command === 'stop') this.stopPending = true;
          this.retryAt = Date.now() + 250;
          this.onError(error);
          break;
        }
      }
    } finally { this.busy = false; }
  }
}
