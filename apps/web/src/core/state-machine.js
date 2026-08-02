const transitions = {
  setup: new Set(['activate']),
  activate: new Set(['setup', 'talk']),
  talk: new Set(['activate'])
};

export class UiStateMachine {
  constructor(initial = 'setup', onChange = () => {}) {
    this.state = initial;
    this.onChange = onChange;
  }

  can(next) {
    return this.state === next || transitions[this.state]?.has(next);
  }

  move(next, { force = false } = {}) {
    if (!force && !this.can(next)) throw new Error(`Invalid UI transition: ${this.state} -> ${next}`);
    this.state = next;
    this.onChange(next);
  }
}
