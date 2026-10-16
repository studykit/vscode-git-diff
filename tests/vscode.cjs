const Module = require("node:module");

class Uri {
  constructor(parts) { Object.assign(this, parts); this.fsPath = this.path; }
  static from(parts) { return new Uri(parts); }
  static parse(value) {
    const url = new URL(value);
    return new Uri({ scheme: url.protocol.slice(0, -1), path: url.pathname, query: url.search.slice(1) });
  }
}

const state = { commands: new Map(), errors: [], view: undefined, uriHandler: undefined, failReveal: false, hideView: false };
const disposable = () => ({ dispose() {} });
const vscode = {
  Uri,
  EventEmitter: class { event = () => disposable(); fire() {} },
  TreeItem: class { constructor(label, collapsibleState) { Object.assign(this, { label, collapsibleState }); } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  MarkdownString: class { constructor(value) { this.value = value; } },
  window: {
    createOutputChannel: () => ({ ...disposable(), info() {}, warn() {}, error() {} }),
    createTreeView: (_id, options) => {
      state.view = { ...disposable(), ...options, visible: false, selection: [], async reveal(node) {
        if (state.failReveal) throw new Error("Reveal failed");
        if (state.onReveal) await state.onReveal(node);
        this.selection = [node];
      } };
      return state.view;
    },
    registerFileDecorationProvider: disposable,
    registerUriHandler: (handler) => { state.uriHandler = handler; return disposable(); },
    showErrorMessage: (error) => { state.errors.push(error); },
    onDidChangeWindowState: disposable,
  },
  workspace: { textDocuments: [], registerTextDocumentContentProvider: disposable, onDidSaveTextDocument: disposable },
  languages: { registerCodeLensProvider: disposable },
  commands: {
    registerCommand: (name, fn) => { state.commands.set(name, fn); return disposable(); },
    executeCommand: async (name) => {
      if (name === "workbench.view.extension.gitDiff" && !state.hideView) state.view.visible = true;
    },
  },
};
const original = Module._load;
Module._load = function(name, ...args) { return name === "vscode" ? vscode : original.call(this, name, ...args); };
module.exports = { vscode, state };
