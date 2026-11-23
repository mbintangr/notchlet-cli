import { nextEligibleLeaf, treeCounts, type ChangeTree, type ChangeTreeNode, type TreeWarning } from '@notchlet/core';

export interface FormatTreeOptions {
  depth?: number;
  showWarnings?: boolean;
  warnings?: Array<Pick<TreeWarning, 'code' | 'message'>>;
}

export function formatSubtree(node: ChangeTreeNode, options: FormatTreeOptions = {}): string {
  const nodes = flatten(node);
  const counts = treeCounts(nodes);
  const next = nextEligibleLeaf(node);
  const lines = [formatTree(node, options), '', `Nodes: ${counts.total}; done ${counts.done}, in review ${counts.inReview}, in progress ${counts.inProgress}, open ${counts.open}; leaves ${counts.leaves}.`, `Next: ${next?.relativePath ?? 'none'}`];
  if (options.showWarnings && options.warnings?.length) for (const warning of options.warnings) lines.push(`Warning [${warning.code}]: ${warning.message}`);
  return lines.join('\n');
}

function flatten(node: ChangeTreeNode): ChangeTreeNode[] {
  return [node, ...node.children.flatMap(flatten)];
}

function nodeLabel(node: ChangeTreeNode): string {
  const type = node.backlog?.node.itemType ?? 'CHANGE';
  const key = node.backlog?.platform.key;
  const status = node.closed ? 'done' : node.status;
  return `${type} ${node.relativePath} [${status}]${key ? ` ${key}` : ''}`;
}

export function formatTree(node: ChangeTreeNode, options: FormatTreeOptions = {}): string {
  const maxDepth = options.depth ?? Infinity;
  const lines: string[] = [];
  const walk = (current: ChangeTreeNode, depth: number): void => {
    lines.push(`${'  '.repeat(depth)}${nodeLabel(current)}`);
    if (depth + 1 >= maxDepth) return;
    for (const child of current.children) walk(child, depth + 1);
  };
  walk(node, 0);
  return lines.join('\n');
}

export function formatChangeTree(tree: ChangeTree, options: FormatTreeOptions = {}): string {
  const lines: string[] = [];
  for (const root of tree.roots) {
    if (lines.length) lines.push('');
    lines.push(formatTree(root, options));
  }
  const { counts } = tree;
  lines.push('');
  lines.push(`Nodes: ${counts.total}; done ${counts.done}, in review ${counts.inReview}, in progress ${counts.inProgress}, open ${counts.open}; leaves ${counts.leaves}.`);
  const next = nextEligibleLeaf(tree);
  lines.push(`Next: ${next?.relativePath ?? 'none'}`);
  if (options.showWarnings) for (const warning of tree.warnings) lines.push(`Warning [${warning.code}]: ${warning.message}`);
  return lines.join('\n');
}
