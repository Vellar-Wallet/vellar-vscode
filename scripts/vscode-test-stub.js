/**
 * A minimal fake of the `vscode` module, used ONLY by scripts that need to
 * exercise code which genuinely imports `vscode` (dataProvider.ts,
 * webviewProvider.ts, notifications.ts, testPayment/runTestPayment.ts,
 * onboardingProvider.ts) — unlike src/testEntry.ts's modules, these have no
 * vscode-free path, so `external: ["vscode"]` alone isn't enough; esbuild's
 * `--alias:vscode=<this file>` (or the `alias` option) substitutes this
 * module wherever `require("vscode")` appears in the bundle.
 *
 * Deliberately vscode-free at the PROCESS level (no @vscode/test-electron, no
 * real extension host) — same stated constraint as this repo's other five
 * acceptance scripts (see ci.yml's own comment) — this just fakes the small
 * surface these specific modules actually call.
 *
 * Configurable via a small `_test` namespace so a script can drive
 * configuration values, fire events, and inspect what got posted/logged,
 * without needing a real VS Code instance anywhere.
 */

class Uri {
  constructor(p) {
    this.path = p;
  }
  static joinPath(base, ...segs) {
    return new Uri([base.path, ...segs].join("/"));
  }
  static parse(s) {
    return new Uri(s);
  }
}
exports.Uri = Uri;

class EventEmitter {
  constructor() {
    this._listeners = [];
    this.event = (cb) => {
      this._listeners.push(cb);
      return {
        dispose: () => {
          const i = this._listeners.indexOf(cb);
          if (i >= 0) this._listeners.splice(i, 1);
        },
      };
    };
  }
  fire(v) {
    for (const cb of [...this._listeners]) cb(v);
  }
  dispose() {
    this._listeners = [];
  }
}
exports.EventEmitter = EventEmitter;

// Test-controlled state, reset per script run (a fresh `require` of this
// module in a fresh Node process each time — these scripts never share a
// process, so there is no cross-test leakage to worry about).
let configuredPayToAddress = "";
const outputChannelLines = [];
const notificationsShown = [];

exports._test = {
  setPayToAddress(value) {
    configuredPayToAddress = value;
  },
  get outputChannelLines() {
    return outputChannelLines;
  },
  get notificationsShown() {
    return notificationsShown;
  },
};

exports.workspace = {
  getConfiguration: (section) => ({
    get: (key, fallback) => {
      if (section === "vellar-x402" && key === "payToAddress") return configuredPayToAddress;
      return fallback;
    },
  }),
  onDidChangeConfiguration: () => ({ dispose() {} }),
  onDidOpenTextDocument: () => ({ dispose() {} }),
};

exports.window = {
  createOutputChannel: () => ({
    appendLine: (line) => outputChannelLines.push(line),
  }),
  onDidChangeWindowState: () => ({ dispose() {} }),
  showInformationMessage: (text) => {
    notificationsShown.push(text);
    return Promise.resolve(undefined);
  },
  showErrorMessage: (text) => {
    notificationsShown.push(text);
    return Promise.resolve(undefined);
  },
  withProgress: async (_options, task) => {
    const progress = { report: () => {} };
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
    return task(progress, token);
  },
};

exports.commands = {
  executeCommand: () => Promise.resolve(),
};

exports.env = {
  openExternal: () => Promise.resolve(true),
  clipboard: { writeText: () => Promise.resolve() },
};

exports.ProgressLocation = { Notification: 15 };
exports.ViewColumn = { One: 1 };
