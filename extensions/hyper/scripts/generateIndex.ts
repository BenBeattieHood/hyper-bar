/**
 * Writes INDEX.md: every file in the repository, its functions and what each
 * one is responsible for, read from the source's own doc comments.
 *
 * Run with `npm run index` after changing code so the index does not go stale.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import type * as t from '@babel/types';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputFile = 'INDEX.md';
/**
 * Responsibilities for functions without a doc comment, keyed `path::name`.
 * Each entry holds a `description` and a `responsibilities` array with one hash
 * per duty the description lists: the first 8 hex characters of the SHA-256 of
 * a short kebab-case name for that duty. Functions with the same responsibility
 * share its hash, so reuse an existing hash rather than minting a new one.
 * A doc comment in the source always wins; prefer writing one when editing a function.
 */
const sidecarFile = 'scripts/indexDescriptions.json';
const codeExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);
const maxDescriptionLength = 320;

interface FunctionEntry {
  depth: number;
  description: string;
  name: string;
  signature: string;
}

interface FileEntry {
  functions: FunctionEntry[];
  path: string;
  summary: string;
  tests: string[];
}

interface SidecarEntry {
  description: string;
  responsibilities: string[];
}

/** Every file git knows about or would add, sorted by path, leaving out the index itself. */
const trackedFiles = () =>
  execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .filter((path) => path && path !== outputFile && existsSync(join(repoRoot, path)))
    .sort((a, b) => a.localeCompare(b));

/** Whether a path is a unit test, e2e spec or benchmark, which are indexed by what they cover. */
const isTestFile = (path: string) => /\.(test|spec|bench)\.[cm]?[jt]sx?$/.test(path);

/** Flattens comment prose onto one line and reduces `{@link X}` to `X`. */
const oneLine = (text: string) =>
  text
    .replace(/\{@link\s+([^}|\s]+)(?:[|\s][^}]*)?\}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

/** Keeps a description to its first paragraph, cut at a sentence end when it runs long. */
const shorten = (text: string) => {
  const paragraph = oneLine(text.trim().split(/\n\s*\n/)[0] ?? '');
  if (paragraph.length <= maxDescriptionLength) return paragraph;
  const cut = paragraph.slice(0, maxDescriptionLength);
  const sentenceEnd = cut.lastIndexOf('. ');
  return sentenceEnd > 80 ? cut.slice(0, sentenceEnd + 1) : `${cut.trimEnd()}...`;
};

/** Escapes text for a Markdown table cell. */
const cellText = (text: string) => text.replace(/\|/g, '\\|');

/** Whether a comment is a JSDoc block rather than a plain comment. */
const isJsDoc = (comment: t.Comment) => comment.type === 'CommentBlock' && comment.value.startsWith('*');

/** The prose of a JSDoc block, without its stars or its `@tag` lines. */
const jsDocProse = (comment: t.Comment) => {
  const lines = comment.value
    .slice(1)
    .split('\n')
    .map((line) => line.replace(/^\s*\* ?/, ''));
  const firstTag = lines.findIndex((line) => line.trim().startsWith('@'));
  return (firstTag === -1 ? lines : lines.slice(0, firstTag)).join('\n');
};

/** Whether a `//` comment is a lint, type or formatter directive rather than prose. */
const isToolingComment = (text: string) => /^(eslint|@ts-|prettier|#region|#endregion)/.test(text.trim());

/**
 * The doc comment directly above a node: its JSDoc block, or else the run of
 * `//` lines that ends on the line before it.
 */
const describeNode = (node: t.Node) => {
  const comments = node.leadingComments ?? [];
  const last = comments[comments.length - 1];
  if (!last || !node.loc || !last.loc) return '';
  if (isJsDoc(last)) {
    const prose = jsDocProse(last);
    return prose.trim() ? shorten(prose) : '';
  }
  const lines: string[] = [];
  let expectedLine = node.loc.start.line - 1;
  for (const comment of [...comments].reverse()) {
    if (comment.type !== 'CommentLine' || comment.loc?.end.line !== expectedLine) break;
    if (!isToolingComment(comment.value)) lines.unshift(comment.value.trim());
    expectedLine -= 1;
  }
  return lines.length ? shorten(lines.join(' ')) : '';
};

/** A readable name for a parameter, including destructured, defaulted and rest parameters. */
const patternName = (pattern: t.Node): string => {
  switch (pattern.type) {
    case 'Identifier':
      return pattern.name;
    case 'AssignmentPattern':
      return patternName(pattern.left);
    case 'RestElement':
      return `...${patternName(pattern.argument)}`;
    case 'TSParameterProperty':
      return patternName(pattern.parameter);
    case 'ObjectPattern':
      return `{ ${pattern.properties
        .map((property) =>
          property.type === 'RestElement'
            ? patternName(property)
            : property.key.type === 'Identifier'
              ? property.key.name
              : '?',
        )
        .join(', ')} }`;
    case 'ArrayPattern':
      return `[${pattern.elements.map((element) => (element ? patternName(element) : '')).join(', ')}]`;
    default:
      return '?';
  }
};

/** The comma-separated parameter names shown in a function signature. */
const parameterList = (parameters: readonly t.Node[]) =>
  parameters
    .filter((parameter) => !(parameter.type === 'Identifier' && parameter.name === 'this'))
    .map(patternName)
    .join(', ');

type FunctionLike = t.ArrowFunctionExpression | t.FunctionExpression;

/** Calls that return the function they are given, so a `const` holding one still names a function. */
const functionWrapperPattern = /^(React\.)?(memo|forwardRef|useCallback)$/;

/** The function a `const` holds, looking through wrappers such as `memo(...)` and `forwardRef(...)`. */
const functionInitializer = (expression: t.Node | null | undefined): FunctionLike | undefined => {
  if (!expression) return undefined;
  switch (expression.type) {
    case 'ArrowFunctionExpression':
    case 'FunctionExpression':
      return expression;
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'TSNonNullExpression':
    case 'ParenthesizedExpression':
      return functionInitializer(expression.expression);
    case 'CallExpression': {
      if (!functionWrapperPattern.test(calleeName(expression.callee))) return undefined;
      return functionInitializer(expression.arguments[0]);
    }
    default:
      return undefined;
  }
};

/** A generic description for undocumented React components and hooks. */
const fallbackDescription = (name: string, path: string) => {
  if (path.endsWith('.tsx') && /^[A-Z]/.test(name)) return 'React component.';
  if (/^use[A-Z]/.test(name)) return 'React hook.';
  return '';
};

/** The name of a class member key. */
const memberName = (key: t.Node) => {
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'StringLiteral') return key.value;
  return '[computed]';
};

/** Collects named functions in a body: top level always, nested ones only when documented. */
const collectFunctions = (
  statements: readonly t.Statement[],
  path: string,
  depth: number,
  entries: FunctionEntry[],
) => {
  const add = (name: string, parameters: readonly t.Node[], docNodes: t.Node[], body: t.Node) => {
    const description = docNodes.map(describeNode).find(Boolean) ?? '';
    if (depth > 0 && !description) return;
    entries.push({
      depth,
      description: description || fallbackDescription(name, path),
      name,
      signature: `${name}(${parameterList(parameters)})`,
    });
    if (body.type === 'BlockStatement') collectFunctions(body.body, path, depth + 1, entries);
  };

  const addClass = (declaration: t.ClassDeclaration, docNodes: t.Node[]) => {
    const className = declaration.id?.name ?? 'default';
    entries.push({
      depth,
      description: docNodes.map(describeNode).find(Boolean) || 'Class.',
      name: `class ${className}`,
      signature: `class ${className}`,
    });
    for (const member of declaration.body.body) {
      if (member.type !== 'ClassMethod') continue;
      if (member.accessibility === 'private' || member.accessibility === 'protected') continue;
      const description = describeNode(member);
      if (member.kind === 'constructor') {
        if (description) {
          entries.push({
            depth: depth + 1,
            description,
            name: `${className}.constructor`,
            signature: `constructor(${parameterList(member.params)})`,
          });
        }
        continue;
      }
      const prefix = member.kind === 'get' ? 'get ' : member.kind === 'set' ? 'set ' : '';
      const name = `${prefix}${className}.${memberName(member.key)}`;
      entries.push({
        depth: depth + 1,
        description,
        name,
        signature: `${name}(${parameterList(member.params)})`,
      });
    }
  };

  for (const statement of statements) {
    const exported =
      statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration'
        ? statement.declaration
        : undefined;
    const declaration = (exported ?? statement) as t.Node;
    const docNodes = exported ? [statement, declaration] : [statement];

    if (declaration.type === 'FunctionDeclaration') {
      add(declaration.id?.name ?? 'default', declaration.params, docNodes, declaration.body);
    } else if (declaration.type === 'VariableDeclaration') {
      for (const variable of declaration.declarations) {
        const fn = functionInitializer(variable.init);
        if (!fn || variable.id.type !== 'Identifier') continue;
        const variableDocs = declaration.declarations.length === 1 ? [...docNodes, variable] : [variable];
        add(variable.id.name, fn.params, variableDocs, fn.body);
      }
    } else if (declaration.type === 'ClassDeclaration' && depth === 0) {
      addClass(declaration, docNodes);
    }
  }
};

/** A doc comment at the top of the file that belongs to the module rather than its first declaration. */
const moduleSummary = (program: t.Program): string => {
  const first = program.body[0];
  if (!first) return '';
  const blocks = (first.leadingComments ?? []).filter(isJsDoc);
  const describesFirstStatement =
    first.type !== 'ImportDeclaration' &&
    !(first.type === 'ExportNamedDeclaration' && !first.declaration) &&
    first.type !== 'ExpressionStatement';
  const block = (describesFirstStatement ? blocks.slice(0, -1) : blocks)[0];
  return block ? shorten(jsDocProse(block)) : '';
};

/** The dotted name of a call target, such as `test.describe` for `test.describe.serial(...)`. */
const calleeName = (callee: t.Node): string => {
  switch (callee.type) {
    case 'Identifier':
      return callee.name;
    case 'MemberExpression':
      return `${calleeName(callee.object)}.${callee.property.type === 'Identifier' ? callee.property.name : '?'}`;
    case 'CallExpression':
      return calleeName(callee.callee);
    default:
      return '';
  }
};

/** The title passed as the first argument to a `describe` or test call. */
const titleOf = (call: t.CallExpression, source: string) => {
  const argument = call.arguments[0];
  if (!argument) return undefined;
  if (argument.type === 'StringLiteral') return argument.value;
  if (['TemplateLiteral', 'Identifier', 'MemberExpression'].includes(argument.type)) {
    return oneLine(source.slice(argument.start ?? 0, argument.end ?? 0));
  }
  return undefined;
};

const describePattern = /^(test\.)?describe(\.(only|skip|serial|parallel|each))*$/;
const testPattern = /^(it|test|bench)(\.(only|skip|fixme|fail|each|concurrent|todo))*$/;

/** Top-level `describe` titles, or the test titles themselves when a file has no describe blocks. */
const testTitles = (program: t.Program, source: string): string[] => {
  const describes: string[] = [];
  const tests: string[] = [];
  const visit = (node: unknown, insideDescribe: boolean): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((child) => visit(child, insideDescribe));
      return;
    }
    const candidate = node as t.Node;
    if (candidate.type === 'CallExpression') {
      const callee = calleeName(candidate.callee);
      if (describePattern.test(callee)) {
        const title = titleOf(candidate, source);
        if (!insideDescribe && title) describes.push(title);
        visit(candidate.arguments, true);
        return;
      }
      if (testPattern.test(callee)) {
        const title = titleOf(candidate, source);
        if (title) tests.push(title);
        return;
      }
    }
    for (const [key, value] of Object.entries(candidate)) {
      if (key === 'loc' || key === 'extra' || key.endsWith('Comments')) continue;
      if (value && typeof value === 'object') visit(value, insideDescribe);
    }
  };
  visit(program, false);
  return describes.length ? describes : tests;
};

/** The first top-level heading of a Markdown file. */
const markdownTitle = (text: string) => text.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? '';

/** Parses one file into its summary, its functions or, for tests, the behaviour it covers. */
const describeFile = (path: string): FileEntry => {
  const entry: FileEntry = { functions: [], path, summary: '', tests: [] };
  const extension = extname(path);
  if (extension === '.md') {
    entry.summary = markdownTitle(readFileSync(join(repoRoot, path), 'utf8'));
    return entry;
  }
  if (!codeExtensions.has(extension)) return entry;
  const source = readFileSync(join(repoRoot, path), 'utf8');
  const { program } = parse(source, {
    errorRecovery: true,
    plugins: extension === '.tsx' ? ['typescript', 'jsx'] : ['typescript'],
    sourceType: 'module',
  });
  entry.summary = moduleSummary(program);
  if (isTestFile(path)) entry.tests = testTitles(program, source);
  else collectFunctions(program.body, path, 0, entry.functions);
  return entry;
};

/** The folder a path sits in, with `.` for the repository root. */
const folderOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.');

/** The heading shown for a folder. */
const folderTitle = (folder: string) => (folder === '.' ? 'Repository root' : folder);

/** The GitHub Markdown anchor for a heading. */
const anchorFor = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .replace(/ /g, '-');

/** The Markdown section for one file. */
const renderFile = (file: FileEntry): string[] => {
  const lines = [`### \`${file.path}\``, ''];
  if (file.summary) lines.push(file.summary, '');
  if (file.functions.length) {
    lines.push('| Function | Responsibility |', '| --- | --- |');
    for (const fn of file.functions) {
      const nesting = fn.depth > 0 ? `${'&nbsp;&nbsp;&nbsp;&nbsp;'.repeat(fn.depth)}↳ ` : '';
      lines.push(`| ${nesting}\`${cellText(fn.signature)}\` | ${cellText(fn.description || '-')} |`);
    }
    lines.push('');
  }
  if (file.tests.length) lines.push(`Covers: ${file.tests.map((title) => `"${title}"`).join(', ')}.`, '');
  return lines;
};

/** The whole index: header, folder list and one section per file. */
const render = (files: FileEntry[]) => {
  const byFolder = new Map<string, FileEntry[]>();
  for (const file of files) {
    const folder = folderOf(file.path);
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), file]);
  }
  const folders = [...byFolder.keys()].sort((a, b) =>
    a === '.' ? -1 : b === '.' ? 1 : a.localeCompare(b),
  );
  const functionCount = files.reduce((total, file) => total + file.functions.length, 0);

  const lines = [
    '<!-- Auto-generated by scripts/generateIndex.ts. Do not edit by hand; run `npm run index`. -->',
    '',
    '# Hyper file index',
    '',
    `Every file in the repository (${files.length}), grouped by folder, with its functions (${functionCount}) and what each one is responsible for.`,
    `Responsibilities come from the doc comments in the source, or from \`${sidecarFile}\` for functions without one.`,
    'Nested entries (↳) are documented helpers or methods defined inside the function or class above them.',
    'Test files list the behaviour they cover instead of their functions.',
    '',
    '## Folders',
    '',
    ...folders.map(
      (folder) =>
        `- [${folderTitle(folder)}](#${anchorFor(folderTitle(folder))}) (${byFolder.get(folder)?.length ?? 0} files)`,
    ),
    '',
  ];
  for (const folder of folders) {
    lines.push(`## ${folderTitle(folder)}`, '');
    for (const file of byFolder.get(folder) ?? []) lines.push(...renderFile(file));
  }
  return `${lines.join('\n').trimEnd()}\n`;
};

/**
 * A stored sidecar entry in its current shape, upgrading a bare description
 * string so an entry added that way is kept rather than dropped as stale.
 */
const sidecarEntry = (value: SidecarEntry | string | undefined): SidecarEntry | undefined => {
  if (typeof value === 'string') return value ? { description: value, responsibilities: [] } : undefined;
  if (!value?.description) return undefined;
  return { description: value.description, responsibilities: value.responsibilities ?? [] };
};

/**
 * Fills undocumented functions from the sidecar and drops sidecar entries that
 * no longer match an undocumented function, so it never drifts from the code.
 */
const applySidecar = (files: FileEntry[]) => {
  const sidecarPath = join(repoRoot, sidecarFile);
  const stored: Record<string, SidecarEntry | string> = existsSync(sidecarPath)
    ? JSON.parse(readFileSync(sidecarPath, 'utf8'))
    : {};
  const kept: Record<string, SidecarEntry> = {};
  const missing: string[] = [];
  for (const file of files) {
    for (const fn of file.functions) {
      if (fn.description) continue;
      const key = `${file.path}::${fn.name}`;
      const entry = sidecarEntry(stored[key]);
      if (entry) {
        fn.description = entry.description;
        kept[key] = entry;
      } else {
        missing.push(`${key} (${fn.signature})`);
      }
    }
  }
  const sorted = Object.entries(kept).sort(([a], [b]) => a.localeCompare(b));
  writeFileSync(sidecarPath, `${JSON.stringify(Object.fromEntries(sorted), null, 2)}\n`);
  const unhashed = sorted.filter(([, entry]) => entry.responsibilities.length === 0).map(([key]) => key);
  return { dropped: Object.keys(stored).length - Object.keys(kept).length, missing, unhashed };
};

const files = trackedFiles().map(describeFile);
const { dropped, missing, unhashed } = applySidecar(files);
writeFileSync(join(repoRoot, outputFile), render(files));
const functionTotal = files.reduce((total, file) => total + file.functions.length, 0);
console.log(`Wrote ${outputFile}: ${files.length} files, ${functionTotal} functions.`);
if (dropped) console.log(`Dropped ${dropped} stale entries from ${sidecarFile}.`);
if (missing.length) {
  console.log(
    `${missing.length} functions have no description. Add a doc comment, or a { description, responsibilities } entry in ${sidecarFile}:\n${missing.join('\n')}`,
  );
}
if (unhashed.length) {
  console.log(`${unhashed.length} entries in ${sidecarFile} have no responsibility hashes:\n${unhashed.join('\n')}`);
}
