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
// undefined means "unset" — get()'s own fallback (the real declared default,
// "stellar:pubnet") applies, exactly like a real VS Code settings.json with
// no vellar-x402.network entry at all.
let configuredNetwork;
const outputChannelLines = [];
const notificationsShown = [];

// Real event emitter (not a no-op) so a script can prove code that calls
// vscode.workspace.getConfiguration(...).update(...) actually fires a real
// onDidChangeConfiguration event afterward — same object real VS Code fires,
// with a real, queryable affectsConfiguration(section) rather than a fake
// that always/never matches, so a listener's own filtering logic (see
// webviewProvider.ts's `e.affectsConfiguration("vellar-x402.network")`
// check) is exercised for real, not assumed to work.
const configChangeEmitter = new EventEmitter();
function fireConfigChanged(section) {
  configChangeEmitter.fire({ affectsConfiguration: (s) => s === section });
}

exports._test = {
  setPayToAddress(value) {
    configuredPayToAddress = value;
  },
  setNetwork(value) {
    configuredNetwork = value;
  },
  resetNetwork() {
    configuredNetwork = undefined;
  },
  // Simulates an EXTERNAL edit (native Settings UI, a direct settings.json
  // edit) — sets the value directly, bypassing update() entirely, then fires
  // the same event update() itself fires below, so a test can distinguish
  // "the toggle's own write" from "some other process changed the setting"
  // even though both paths converge on the same event shape.
  setNetworkExternally(value) {
    configuredNetwork = value;
    fireConfigChanged("vellar-x402.network");
  },
  setNextInputBoxValue(value) {
    nextInputBoxValue = value;
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
      if (section === "vellar-x402" && key === "network") return configuredNetwork ?? fallback;
      return fallback;
    },
    // Real VS Code's update() is async (it can hit disk) — matched here so a
    // caller that awaits it (DataProvider.setConfiguredNetwork does) is
    // actually testing its own await, not one that would trivially "work"
    // against a synchronous fake.
    update: (key, value) => {
      if (section === "vellar-x402" && key === "network") {
        configuredNetwork = value;
        fireConfigChanged("vellar-x402.network");
      }
      return Promise.resolve();
    },
  }),
  onDidChangeConfiguration: configChangeEmitter.event,
  onDidOpenTextDocument: () => ({ dispose() {} }),
};

// The NEXT value showInputBox resolves to — a script sets this immediately
// before triggering whatever code calls showInputBox, same
// "test-controlled, reset per script run" spirit as configuredPayToAddress
// above. undefined models the user pressing Escape (cancel).
let nextInputBoxValue;

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
  showInputBox: () => Promise.resolve(nextInputBoxValue),
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
exports.ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };

// Real SecretStorage fake — an in-memory Map, not a no-op — so a script can
// prove code that calls secrets.store/get/delete actually round-trips a
// value, the same "real behavior, not a stub that always/never matches"
// standard the config-change emitter above already holds itself to. A
// FACTORY (not a single shared module-level instance) since a test script
// may construct several independent providers/DataProviders in the same
// process (see network-toggle-entry.ts's own per-test setup()) and each
// should get its own isolated secret store, exactly like a real extension's
// context.secrets is scoped per-extension-install, not shared globally.
exports._test.createFakeSecretStorage = function createFakeSecretStorage() {
  const store = new Map();
  const changeEmitter = new EventEmitter();
  return {
    get: (key) => Promise.resolve(store.get(key)),
    store: (key, value) => {
      store.set(key, value);
      changeEmitter.fire({ key });
      return Promise.resolve();
    },
    delete: (key) => {
      store.delete(key);
      changeEmitter.fire({ key });
      return Promise.resolve();
    },
    keys: () => Promise.resolve([...store.keys()]),
    onDidChange: changeEmitter.event,
  };
};
