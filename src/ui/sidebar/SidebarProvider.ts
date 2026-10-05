import * as vscode from 'vscode';
import { EnrichedObject } from '../../sap/ObjectDiscovery';

// Icon mapping per ABAP object type
const TYPE_ICON: Record<string, string> = {
  PROG: 'symbol-file',
  CLAS: 'symbol-class',
  INTF: 'symbol-interface',
  FUGR: 'symbol-method',
  TABL: 'database',
  DTEL: 'symbol-field',
  DOMA: 'symbol-enum',
  MSAG: 'comment',
};

// Classification badge labels
const CLASS_LABEL: Record<string, string> = {
  A: '[A]',
  B: '[B]',
  C: '[C]',
  D: '[D]',
};

// ── Tree items ───────────────────────────────────────────────────────────────

export class PackageTreeItem extends vscode.TreeItem {
  constructor(
    public readonly packageName: string,
    public readonly childCount: number
  ) {
    super(packageName, vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${childCount} object${childCount !== 1 ? 's' : ''}`;
    this.iconPath = new vscode.ThemeIcon('package');
    this.contextValue = 'package';
  }
}

export class SapObjectTreeItem extends vscode.TreeItem {
  constructor(public readonly obj: EnrichedObject) {
    super(obj.name, vscode.TreeItemCollapsibleState.None);

    const classStr = obj.classification ? ` ${CLASS_LABEL[obj.classification]}` : '';
    this.description = `${obj.type}${classStr}`;
    this.tooltip = new vscode.MarkdownString(
      `**${obj.name}** (${obj.type})\n\n` +
      `📦 Package: \`${obj.packageName || '—'}\`\n\n` +
      `📝 ${obj.description || 'No description'}\n\n` +
      `📏 LOC: ${obj.loc ?? '?'} | 👥 Used by: ${obj.callerScanStatus === 'success' || obj.callerCount > 0 ? obj.callerCount : '?'} | ` +
      `🔄 Changes (12m): ${obj.changesLast12Months}`
    );
    this.iconPath = new vscode.ThemeIcon(TYPE_ICON[obj.type] ?? 'symbol-misc');
    this.contextValue = 'sapObject';

    // Open dashboard on click
    this.command = {
      command: 'corepilot.openDashboard',
      title: 'Open Dashboard',
    };
  }
}

type TreeNode = PackageTreeItem | SapObjectTreeItem | vscode.TreeItem;

// ── SidebarProvider ──────────────────────────────────────────────────────────

export class SidebarProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _objects: EnrichedObject[] = [];
  private _packageMap: Map<string, EnrichedObject[]> = new Map();

  constructor(private context: vscode.ExtensionContext) { }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeNode): vscode.ProviderResult<TreeNode[]> {
    // Root level → show packages (or placeholder)
    if (!element) {
      if (this._objects.length === 0) {
        const placeholder = new vscode.TreeItem(
          'No objects scanned yet',
          vscode.TreeItemCollapsibleState.None
        );
        placeholder.description = 'Open Dashboard → Start Scan';
        placeholder.iconPath = new vscode.ThemeIcon('info');
        return [placeholder];
      }
      // Return package nodes
      return Array.from(this._packageMap.entries()).map(
        ([pkg, objs]) => new PackageTreeItem(pkg, objs.length)
      );
    }

    // Package level → show objects in that package
    if (element instanceof PackageTreeItem) {
      const objs = this._packageMap.get(element.packageName) ?? [];
      return objs.map(o => new SapObjectTreeItem(o));
    }

    return [];
  }

  /** Update the tree with new scan results. */
  refresh(objects: EnrichedObject[]): void {
    this._objects = objects;
    this._packageMap = new Map();

    for (const obj of objects) {
      const pkg = obj.packageName || '(no package)';
      if (!this._packageMap.has(pkg)) this._packageMap.set(pkg, []);
      this._packageMap.get(pkg)!.push(obj);
    }

    // Sort packages alphabetically
    this._packageMap = new Map(
      [...this._packageMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    );

    this._onDidChangeTreeData.fire();
  }
}
