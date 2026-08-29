/**
 * A minimal in-memory stand-in for vscode.Memento (globalState/workspaceState),
 * used by scripts that need to construct a real DataProvider (which requires
 * one) without a real extension host. Not part of the shipped extension.
 */
class FakeMemento {
  constructor() {
    this.store = new Map();
  }
  get(key, defaultValue) {
    return this.store.has(key) ? this.store.get(key) : defaultValue;
  }
  update(key, value) {
    this.store.set(key, value);
    return Promise.resolve();
  }
}
module.exports = { FakeMemento };
