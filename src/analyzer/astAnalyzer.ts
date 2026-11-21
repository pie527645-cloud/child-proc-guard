import path from 'node:path';
import ts from 'typescript';
import { RULE_MAP } from '../rules.js';
import type { Finding, RuleId, SourceInput } from '../types.js';
import {
  buildScopeIndex,
  type CpFunctionKind,
  isEventsNamespaceExpr,
  isTreeKillRef,
  resolveCpFunctionRef,
  type ScopeIndex,
  unwrapExpr,
} from './scopeTracker.js';

export interface AnalyzerOptions {
  readonly includeTests?: boolean;
}

function getScriptKind(filePath: string): ts.ScriptKind {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

function createFinding(
  sourceFile: ts.SourceFile,
  displayPath: string,
  node: ts.Node,
  ruleId: RuleId,
  message: string
): Finding {
  const rule = RULE_MAP.get(ruleId);
  const severity = rule ? rule.defaultSeverity : 'medium';
  const startPos = node.getStart(sourceFile);
  const endPos = node.getEnd();
  const startLoc = sourceFile.getLineAndCharacterOfPosition(startPos);
  const endLoc = sourceFile.getLineAndCharacterOfPosition(endPos);

  return {
    ruleId,
    severity,
    message,
    file: displayPath,
    line: startLoc.line + 1,
    column: startLoc.character + 1,
    endLine: endLoc.line + 1,
    endColumn: endLoc.character + 1,
  };
}

function resolveSingleValueExpr(
  rawExpr: ts.Expression,
  scopeIndex: ScopeIndex,
  visited: Set<ts.Node> = new Set()
): ts.Expression {
  let curr = unwrapExpr(rawExpr);
  while (ts.isIdentifier(curr)) {
    if (curr.text === 'undefined') {
      return curr;
    }
    const binding = scopeIndex.lookup(curr, curr.text);
    if (
      binding?.kind === 'local' &&
      (binding.isConst || !binding.mutated) &&
      binding.initializer !== undefined &&
      !visited.has(binding.declNode)
    ) {
      visited.add(binding.declNode);
      curr = unwrapExpr(binding.initializer);
      continue;
    }
    break;
  }
  return curr;
}

function isNullOrUndefinedExpr(rawExpr: ts.Expression, scopeIndex: ScopeIndex): boolean {
  const expr = resolveSingleValueExpr(rawExpr, scopeIndex);
  if (expr.kind === ts.SyntaxKind.NullKeyword) {
    return true;
  }
  if (ts.isIdentifier(expr) && expr.text === 'undefined') {
    return true;
  }
  if (ts.isVoidExpression(expr)) {
    return true;
  }
  return false;
}

function isFunctionValueExpr(
  rawExpr: ts.Expression,
  scopeIndex: ScopeIndex,
  visited: Set<ts.Node> = new Set()
): boolean {
  const expr = unwrapExpr(rawExpr);
  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
    return true;
  }
  if (ts.isIdentifier(expr)) {
    const binding = scopeIndex.lookup(expr, expr.text);
    if (binding?.kind === 'functionDecl') {
      return true;
    }
    if (
      binding?.kind === 'local' &&
      (binding.isConst || !binding.mutated) &&
      binding.initializer !== undefined &&
      !visited.has(binding.declNode)
    ) {
      visited.add(binding.declNode);
      return isFunctionValueExpr(binding.initializer, scopeIndex, visited);
    }
  }
  return false;
}

function isArrayTypeNode(rawType: ts.TypeNode): boolean {
  let curr = rawType;
  while (ts.isParenthesizedTypeNode(curr)) {
    curr = curr.type;
  }
  if (ts.isArrayTypeNode(curr) || ts.isTupleTypeNode(curr)) {
    return true;
  }
  if (ts.isTypeOperatorNode(curr)) {
    return isArrayTypeNode(curr.type);
  }
  if (ts.isTypeReferenceNode(curr) && ts.isIdentifier(curr.typeName)) {
    return curr.typeName.text === 'Array' || curr.typeName.text === 'ReadonlyArray';
  }
  return false;
}

function isArgsArrayExpr(
  rawExpr: ts.Expression,
  scopeIndex: ScopeIndex,
  visited: Set<ts.Node> = new Set()
): boolean {
  let inspectRaw = rawExpr;
  while (ts.isParenthesizedExpression(inspectRaw)) {
    inspectRaw = inspectRaw.expression;
  }
  if (
    (ts.isAsExpression(inspectRaw) || ts.isSatisfiesExpression(inspectRaw)) &&
    isArrayTypeNode(inspectRaw.type)
  ) {
    return true;
  }

  const expr = unwrapExpr(rawExpr);
  if (ts.isArrayLiteralExpression(expr)) {
    return true;
  }
  if (ts.isIdentifier(expr)) {
    const binding = scopeIndex.lookup(expr, expr.text);
    if (binding?.kind === 'local') {
      if (binding.typeNode && isArrayTypeNode(binding.typeNode)) {
        return true;
      }
      if (
        (binding.isConst || !binding.mutated) &&
        binding.initializer !== undefined &&
        !visited.has(binding.declNode)
      ) {
        visited.add(binding.declNode);
        return isArgsArrayExpr(binding.initializer, scopeIndex, visited);
      }
    } else if (binding?.kind === 'shadowed') {
      if (binding.typeNode && isArrayTypeNode(binding.typeNode)) {
        return true;
      }
    }
  }
  return false;
}

interface ExtractedObjectProps {
  readonly props: Map<string, ts.Expression>;
  readonly hasOpaqueSpread: boolean;
}

function getPropertyKeyText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) {
    const inner = unwrapExpr(name.expression);
    if (ts.isStringLiteralLike(inner) || ts.isNumericLiteral(inner)) {
      return inner.text;
    }
  }
  return undefined;
}

function extractObjectProperties(
  objLiteral: ts.ObjectLiteralExpression,
  scopeIndex: ScopeIndex,
  visited: Set<ts.Node> = new Set()
): ExtractedObjectProps {
  const props = new Map<string, ts.Expression>();
  let hasOpaqueSpread = false;

  if (visited.has(objLiteral)) {
    return { props, hasOpaqueSpread: false };
  }
  visited.add(objLiteral);

  for (const prop of objLiteral.properties) {
    if (ts.isPropertyAssignment(prop)) {
      const key = getPropertyKeyText(prop.name);
      if (key !== undefined) {
        props.set(key, prop.initializer);
      }
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      props.set(prop.name.text, prop.name);
    } else if (ts.isSpreadAssignment(prop)) {
      const resolvedSpread = resolveSingleValueExpr(prop.expression, scopeIndex);
      if (ts.isObjectLiteralExpression(resolvedSpread)) {
        const nested = extractObjectProperties(resolvedSpread, scopeIndex, visited);
        for (const [k, v] of nested.props.entries()) {
          props.set(k, v);
        }
        if (nested.hasOpaqueSpread) {
          hasOpaqueSpread = true;
        }
      } else if (!isNullOrUndefinedExpr(prop.expression, scopeIndex)) {
        hasOpaqueSpread = true;
      }
    }
  }

  return { props, hasOpaqueSpread };
}

function evalStaticNumber(
  rawExpr: ts.Expression,
  scopeIndex: ScopeIndex,
  visited: Set<ts.Node> = new Set()
): number | undefined {
  const expr = unwrapExpr(rawExpr);
  if (ts.isNumericLiteral(expr)) {
    return Number(expr.text);
  }
  if (ts.isIdentifier(expr)) {
    if (expr.text === 'NaN') {
      return Number.NaN;
    }
    if (expr.text === 'Infinity') {
      return Number.POSITIVE_INFINITY;
    }
    const binding = scopeIndex.lookup(expr, expr.text);
    if (
      binding?.kind === 'local' &&
      (binding.isConst || !binding.mutated) &&
      binding.initializer !== undefined &&
      !visited.has(binding.declNode)
    ) {
      visited.add(binding.declNode);
      return evalStaticNumber(binding.initializer, scopeIndex, visited);
    }
    return undefined;
  }
  if (ts.isPrefixUnaryExpression(expr)) {
    const inner = evalStaticNumber(expr.operand, scopeIndex, visited);
    if (inner === undefined) {
      return undefined;
    }
    if (expr.operator === ts.SyntaxKind.MinusToken) {
      return -inner;
    }
    if (expr.operator === ts.SyntaxKind.PlusToken) {
      return +inner;
    }
    return undefined;
  }
  if (ts.isBinaryExpression(expr)) {
    const left = evalStaticNumber(expr.left, scopeIndex, visited);
    const right = evalStaticNumber(expr.right, scopeIndex, visited);
    if (left === undefined || right === undefined) {
      return undefined;
    }
    switch (expr.operatorToken.kind) {
      case ts.SyntaxKind.PlusToken:
        return left + right;
      case ts.SyntaxKind.MinusToken:
        return left - right;
      case ts.SyntaxKind.AsteriskToken:
        return left * right;
      case ts.SyntaxKind.SlashToken:
        return right === 0 ? Number.NaN : left / right;
      default:
        return undefined;
    }
  }
  return undefined;
}

function isValidPositiveTimeoutExpr(rawExpr: ts.Expression, scopeIndex: ScopeIndex): boolean {
  if (isNullOrUndefinedExpr(rawExpr, scopeIndex)) {
    return false;
  }
  const resolved = resolveSingleValueExpr(rawExpr, scopeIndex);
  if (
    resolved.kind === ts.SyntaxKind.FalseKeyword ||
    resolved.kind === ts.SyntaxKind.TrueKeyword
  ) {
    return false;
  }
  const staticNum = evalStaticNumber(resolved, scopeIndex);
  if (staticNum !== undefined) {
    return Number.isFinite(staticNum) && staticNum > 0;
  }
  return true;
}

type OptionsLocation =
  | { readonly kind: 'skip' }
  | { readonly kind: 'omitted' }
  | { readonly kind: 'present'; readonly expr: ts.Expression };

function locateCpg001Options(
  fnKind: Exclude<CpFunctionKind, 'spawn' | 'fork'>,
  args: ts.NodeArray<ts.Expression>,
  scopeIndex: ScopeIndex
): OptionsLocation {
  if (args.length === 0) {
    return { kind: 'skip' };
  }

  switch (fnKind) {
    case 'exec': {
      if (args.length === 1) {
        return { kind: 'omitted' };
      }
      if (args.length === 2) {
        if (
          isNullOrUndefinedExpr(args[1], scopeIndex) ||
          isFunctionValueExpr(args[1], scopeIndex)
        ) {
          return { kind: 'omitted' };
        }
        return { kind: 'present', expr: args[1] };
      }
      if (isNullOrUndefinedExpr(args[1], scopeIndex)) {
        return { kind: 'omitted' };
      }
      return { kind: 'present', expr: args[1] };
    }

    case 'promisified_exec':
    case 'execSync': {
      if (args.length === 1) {
        return { kind: 'omitted' };
      }
      if (isNullOrUndefinedExpr(args[1], scopeIndex)) {
        return { kind: 'omitted' };
      }
      return { kind: 'present', expr: args[1] };
    }

    case 'execFile': {
      if (args.length === 1) {
        return { kind: 'omitted' };
      }
      if (args.length === 2) {
        if (
          isNullOrUndefinedExpr(args[1], scopeIndex) ||
          isFunctionValueExpr(args[1], scopeIndex) ||
          isArgsArrayExpr(args[1], scopeIndex)
        ) {
          return { kind: 'omitted' };
        }
        return { kind: 'present', expr: args[1] };
      }
      if (args.length === 3) {
        if (
          isFunctionValueExpr(args[2], scopeIndex) ||
          isNullOrUndefinedExpr(args[2], scopeIndex)
        ) {
          if (
            isNullOrUndefinedExpr(args[1], scopeIndex) ||
            isArgsArrayExpr(args[1], scopeIndex)
          ) {
            return { kind: 'omitted' };
          }
          return { kind: 'present', expr: args[1] };
        }
        return { kind: 'present', expr: args[2] };
      }
      if (isNullOrUndefinedExpr(args[2], scopeIndex)) {
        return { kind: 'omitted' };
      }
      return { kind: 'present', expr: args[2] };
    }

    case 'promisified_execFile':
    case 'execFileSync':
    case 'spawnSync': {
      if (args.length === 1) {
        return { kind: 'omitted' };
      }
      if (args.length === 2) {
        if (
          isNullOrUndefinedExpr(args[1], scopeIndex) ||
          isArgsArrayExpr(args[1], scopeIndex)
        ) {
          return { kind: 'omitted' };
        }
        return { kind: 'present', expr: args[1] };
      }
      if (isNullOrUndefinedExpr(args[2], scopeIndex)) {
        return { kind: 'omitted' };
      }
      return { kind: 'present', expr: args[2] };
    }
  }
}

function doesOptionsMissTimeoutAndSignal(
  rawOptionsExpr: ts.Expression,
  scopeIndex: ScopeIndex,
  depth = 0
): boolean {
  if (depth > 8) {
    return false;
  }
  const resolved = resolveSingleValueExpr(rawOptionsExpr, scopeIndex);
  if (isNullOrUndefinedExpr(resolved, scopeIndex)) {
    return true;
  }
  if (ts.isConditionalExpression(resolved)) {
    return (
      doesOptionsMissTimeoutAndSignal(resolved.whenTrue, scopeIndex, depth + 1) ||
      doesOptionsMissTimeoutAndSignal(resolved.whenFalse, scopeIndex, depth + 1)
    );
  }
  if (!ts.isObjectLiteralExpression(resolved)) {
    return false;
  }

  const { props, hasOpaqueSpread } = extractObjectProperties(resolved, scopeIndex);
  const timeoutExpr = props.get('timeout');
  const signalExpr = props.get('signal');

  const hasValidTimeout =
    timeoutExpr !== undefined && isValidPositiveTimeoutExpr(timeoutExpr, scopeIndex);
  const hasValidSignal =
    signalExpr !== undefined && !isNullOrUndefinedExpr(signalExpr, scopeIndex);

  if (hasValidTimeout || hasValidSignal) {
    return false;
  }

  if (hasOpaqueSpread) {
    const bothOverriddenInvalid = timeoutExpr !== undefined && signalExpr !== undefined;
    if (!bothOverriddenInvalid) {
      return false;
    }
  }

  return true;
}

function formatFnDisplayName(fnKind: Exclude<CpFunctionKind, 'spawn' | 'fork'>): string {
  if (fnKind === 'promisified_exec') {
    return 'promisified exec()';
  }
  if (fnKind === 'promisified_execFile') {
    return 'promisified execFile()';
  }
  return `${fnKind}()`;
}

function checkCpg001(
  sourceFile: ts.SourceFile,
  displayPath: string,
  callExpr: ts.CallExpression,
  fnKind: Exclude<CpFunctionKind, 'spawn' | 'fork'>,
  scopeIndex: ScopeIndex,
  findings: Finding[]
): void {
  const loc = locateCpg001Options(fnKind, callExpr.arguments, scopeIndex);
  if (loc.kind === 'skip') {
    return;
  }
  if (loc.kind === 'omitted') {
    findings.push(
      createFinding(
        sourceFile,
        displayPath,
        callExpr,
        'CPG001',
        `${formatFnDisplayName(fnKind)} is called without a timeout or AbortSignal signal option.`
      )
    );
    return;
  }
  if (doesOptionsMissTimeoutAndSignal(loc.expr, scopeIndex)) {
    findings.push(
      createFinding(
        sourceFile,
        displayPath,
        callExpr,
        'CPG001',
        `${formatFnDisplayName(fnKind)} options omit both a positive timeout and an AbortSignal signal.`
      )
    );
  }
}

function locateSpawnOptions(
  args: ts.NodeArray<ts.Expression>,
  scopeIndex: ScopeIndex
): ts.Expression | undefined {
  if (args.length <= 1) {
    return undefined;
  }
  if (args.length === 2) {
    if (isNullOrUndefinedExpr(args[1], scopeIndex) || isArgsArrayExpr(args[1], scopeIndex)) {
      return undefined;
    }
    return args[1];
  }
  if (isNullOrUndefinedExpr(args[2], scopeIndex)) {
    return undefined;
  }
  return args[2];
}

interface PipedStreamsInfo {
  readonly stdoutPiped: boolean;
  readonly stderrPiped: boolean;
}

function isStdioArrayEntryPiped(
  arr: ts.ArrayLiteralExpression,
  index: number,
  scopeIndex: ScopeIndex
): boolean {
  if (index >= arr.elements.length) {
    return true;
  }
  const el = arr.elements[index];
  if (ts.isOmittedExpression(el)) {
    return true;
  }
  if (ts.isSpreadElement(el)) {
    return false;
  }
  const resolved = resolveSingleValueExpr(el, scopeIndex);
  if (isNullOrUndefinedExpr(resolved, scopeIndex)) {
    return true;
  }
  if (ts.isStringLiteralLike(resolved)) {
    return resolved.text === 'pipe' || resolved.text === 'overlapped';
  }
  return false;
}

function analyzeSpawnPipedStreams(
  optionsExpr: ts.Expression | undefined,
  scopeIndex: ScopeIndex
): PipedStreamsInfo {
  if (optionsExpr === undefined) {
    return { stdoutPiped: true, stderrPiped: true };
  }
  const resolved = resolveSingleValueExpr(optionsExpr, scopeIndex);
  if (isNullOrUndefinedExpr(resolved, scopeIndex)) {
    return { stdoutPiped: true, stderrPiped: true };
  }
  if (!ts.isObjectLiteralExpression(resolved)) {
    return { stdoutPiped: false, stderrPiped: false };
  }

  const { props, hasOpaqueSpread } = extractObjectProperties(resolved, scopeIndex);
  const stdioProp = props.get('stdio');
  if (stdioProp === undefined) {
    if (hasOpaqueSpread) {
      return { stdoutPiped: false, stderrPiped: false };
    }
    return { stdoutPiped: true, stderrPiped: true };
  }

  const stdioVal = resolveSingleValueExpr(stdioProp, scopeIndex);
  if (isNullOrUndefinedExpr(stdioVal, scopeIndex)) {
    return { stdoutPiped: true, stderrPiped: true };
  }
  if (ts.isStringLiteralLike(stdioVal)) {
    const piped = stdioVal.text === 'pipe' || stdioVal.text === 'overlapped';
    return { stdoutPiped: piped, stderrPiped: piped };
  }
  if (ts.isArrayLiteralExpression(stdioVal)) {
    return {
      stdoutPiped: isStdioArrayEntryPiped(stdioVal, 1, scopeIndex),
      stderrPiped: isStdioArrayEntryPiped(stdioVal, 2, scopeIndex),
    };
  }
  return { stdoutPiped: false, stderrPiped: false };
}

function unwrapUpwardAssertions(node: ts.Node): ts.Node {
  let curr = node;
  while (curr.parent) {
    const p = curr.parent;
    if (
      ts.isParenthesizedExpression(p) ||
      ts.isNonNullExpression(p) ||
      ts.isAsExpression(p) ||
      ts.isSatisfiesExpression(p) ||
      ts.isTypeAssertionExpression(p)
    ) {
      curr = p;
      continue;
    }
    break;
  }
  return curr;
}

function isCloseOrExitEventArg(rawArg: ts.Expression | undefined, scopeIndex: ScopeIndex): boolean {
  if (!rawArg) {
    return false;
  }
  const resolved = resolveSingleValueExpr(rawArg, scopeIndex);
  return ts.isStringLiteralLike(resolved) && (resolved.text === 'close' || resolved.text === 'exit');
}

function isDataOrReadableEventArg(
  rawArg: ts.Expression | undefined,
  scopeIndex: ScopeIndex
): boolean {
  if (!rawArg) {
    return false;
  }
  const resolved = resolveSingleValueExpr(rawArg, scopeIndex);
  if (ts.isStringLiteralLike(resolved)) {
    return resolved.text === 'data' || resolved.text === 'readable';
  }
  return !isNullOrUndefinedExpr(resolved, scopeIndex);
}

function isEventsOnceCloseOrExitCall(
  callExpr: ts.CallExpression,
  childArgNode: ts.Node,
  scopeIndex: ScopeIndex
): boolean {
  if (callExpr.arguments.length < 2) {
    return false;
  }
  if (unwrapExpr(callExpr.arguments[0]) !== unwrapExpr(childArgNode as ts.Expression)) {
    return false;
  }
  if (!isCloseOrExitEventArg(callExpr.arguments[1], scopeIndex)) {
    return false;
  }

  const callee = unwrapExpr(callExpr.expression);
  if (ts.isIdentifier(callee)) {
    const b = scopeIndex.lookup(callee, callee.text);
    if (b?.kind === 'eventsOnce') {
      return true;
    }
    if (callee.text === 'once' && b === undefined) {
      return true;
    }
    return false;
  }
  if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'once') {
    const scope = scopeIndex.getScopeForNode(callee);
    if (isEventsNamespaceExpr(callee.expression, scope)) {
      return true;
    }
    const recv = unwrapExpr(callee.expression);
    if (ts.isIdentifier(recv) && recv.text === 'events') {
      return true;
    }
  }
  return false;
}

const STREAM_CONSUMING_METHODS = new Set<string>([
  'pipe',
  'compose',
  'resume',
  'read',
  'destroy',
  'iterator',
  'forEach',
  'map',
  'filter',
  'toArray',
  'reduce',
  'some',
  'every',
  'find',
  'flatMap',
  'drop',
  'take',
]);

function isIdentifierReferenceSite(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (!parent) {
    return false;
  }
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) {
    return false;
  }
  if (ts.isPropertyAssignment(parent) && parent.name === id) {
    return false;
  }
  if (ts.isBindingElement(parent) && parent.propertyName === id) {
    return false;
  }
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isImportClause(parent) ||
      ts.isNamespaceImport(parent)) &&
    parent.name === id
  ) {
    return false;
  }
  if (ts.isTypeNode(parent)) {
    return false;
  }
  return true;
}

function getBindingIdentifierDeclNode(
  id: ts.Identifier,
  scopeIndex: ScopeIndex
): ts.Node | undefined {
  const binding = scopeIndex.lookup(id, id.text);
  if (!binding) {
    return undefined;
  }
  if (binding.kind === 'local') {
    return binding.declNode;
  }
  if (binding.kind === 'shadowed') {
    return binding.declNode;
  }
  return undefined;
}

function doesExprPassToConsumerOrEscape(startNode: ts.Node): boolean {
  let curr = unwrapUpwardAssertions(startNode);
  while (curr.parent) {
    const p = curr.parent;
    if (
      ts.isFunctionDeclaration(p) ||
      ts.isFunctionExpression(p) ||
      ts.isArrowFunction(p)
    ) {
      if (ts.isArrowFunction(p) && p.body === curr) {
        return true;
      }
      return false;
    }
    if (ts.isReturnStatement(p) && p.expression === curr) {
      return true;
    }
    if (ts.isForOfStatement(p) && p.expression === curr) {
      return true;
    }
    if (ts.isCallExpression(p)) {
      for (const arg of p.arguments) {
        if (arg === curr || unwrapUpwardAssertions(arg) === curr) {
          return true;
        }
      }
      return false;
    }
    if (ts.isNewExpression(p) && p.arguments) {
      for (const arg of p.arguments) {
        if (arg === curr || unwrapUpwardAssertions(arg) === curr) {
          return true;
        }
      }
      return false;
    }
    if (
      ts.isBinaryExpression(p) &&
      p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      p.right === curr &&
      (ts.isPropertyAccessExpression(p.left) || ts.isElementAccessExpression(p.left))
    ) {
      return true;
    }
    if (
      ts.isPropertyAssignment(p) ||
      ts.isShorthandPropertyAssignment(p) ||
      ts.isSpreadAssignment(p) ||
      ts.isObjectLiteralExpression(p) ||
      ts.isArrayLiteralExpression(p) ||
      ts.isSpreadElement(p) ||
      ts.isConditionalExpression(p) ||
      ts.isAwaitExpression(p)
    ) {
      curr = unwrapUpwardAssertions(p);
      continue;
    }
    return false;
  }
  return false;
}

function enclosingFunctionOrSource(node: ts.Node): ts.Node {
  let curr: ts.Node | undefined = node.parent;
  while (curr) {
    if (
      ts.isFunctionDeclaration(curr) ||
      ts.isFunctionExpression(curr) ||
      ts.isArrowFunction(curr) ||
      ts.isMethodDeclaration(curr) ||
      ts.isConstructorDeclaration(curr) ||
      ts.isGetAccessorDeclaration(curr) ||
      ts.isSetAccessorDeclaration(curr) ||
      ts.isSourceFile(curr)
    ) {
      return curr;
    }
    curr = curr.parent;
  }
  return node;
}

function isExportedVariableDeclaration(decl: ts.VariableDeclaration): boolean {
  const list = decl.parent;
  if (!ts.isVariableDeclarationList(list)) {
    return false;
  }
  const stmt = list.parent;
  if (!ts.isVariableStatement(stmt) || !stmt.modifiers) {
    return false;
  }
  return stmt.modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function checkCpg002(
  sourceFile: ts.SourceFile,
  displayPath: string,
  spawnCall: ts.CallExpression,
  scopeIndex: ScopeIndex,
  findings: Finding[]
): void {
  const spawnOptions = locateSpawnOptions(spawnCall.arguments, scopeIndex);
  const { stdoutPiped, stderrPiped } = analyzeSpawnPipedStreams(spawnOptions, scopeIndex);
  if (!stdoutPiped && !stderrPiped) {
    return;
  }

  let waitsOnCloseOrExit = false;
  let escaped = false;
  let stdoutRead = false;
  let stderrRead = false;

  let topExpr: ts.Node = unwrapUpwardAssertions(spawnCall);
  while (
    topExpr.parent &&
    ts.isPropertyAccessExpression(topExpr.parent) &&
    topExpr.parent.expression === topExpr &&
    (topExpr.parent.name.text === 'on' ||
      topExpr.parent.name.text === 'once' ||
      topExpr.parent.name.text === 'addListener') &&
    topExpr.parent.parent &&
    ts.isCallExpression(topExpr.parent.parent) &&
    topExpr.parent.parent.expression === topExpr.parent
  ) {
    const chainedCall = topExpr.parent.parent;
    if (isCloseOrExitEventArg(chainedCall.arguments[0], scopeIndex)) {
      waitsOnCloseOrExit = true;
    }
    topExpr = unwrapUpwardAssertions(chainedCall);
  }

  const childDecls = new Set<ts.Node>();
  const stdoutDecls = new Set<ts.Node>();
  const stderrDecls = new Set<ts.Node>();
  let analysisRoot: ts.Node | undefined;

  const topParent = topExpr.parent;
  if (topParent && ts.isVariableDeclaration(topParent) && topParent.initializer === topExpr) {
    if (isExportedVariableDeclaration(topParent)) {
      return;
    }
    if (ts.isIdentifier(topParent.name)) {
      childDecls.add(topParent);
      const declScope = scopeIndex.resolveDeclarationScope(topParent.name, topParent.name.text);
      analysisRoot = declScope ? declScope.astNode : enclosingFunctionOrSource(spawnCall);
    } else if (ts.isObjectBindingPattern(topParent.name)) {
      const fnRoot = enclosingFunctionOrSource(spawnCall);
      analysisRoot = fnRoot;
      for (const el of topParent.name.elements) {
        if (el.dotDotDotToken) {
          return;
        }
        const propNode = el.propertyName ?? el.name;
        if (ts.isIdentifier(propNode) && ts.isIdentifier(el.name)) {
          if (propNode.text === 'stdout') {
            stdoutDecls.add(el.name);
          } else if (propNode.text === 'stderr') {
            stderrDecls.add(el.name);
          }
        }
      }
    } else {
      return;
    }
  } else if (
    topParent &&
    ts.isBinaryExpression(topParent) &&
    topParent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    topParent.right === topExpr
  ) {
    if (ts.isIdentifier(topParent.left)) {
      const targetDecl = getBindingIdentifierDeclNode(topParent.left, scopeIndex);
      const declScope = scopeIndex.resolveDeclarationScope(topParent.left, topParent.left.text);
      const spawnFnScope = enclosingFunctionOrSource(spawnCall);
      if (targetDecl && declScope && declScope.astNode === spawnFnScope) {
        childDecls.add(targetDecl);
        analysisRoot = declScope.astNode;
      } else {
        return;
      }
    } else {
      return;
    }
  } else if (
    topParent &&
    ts.isCallExpression(topParent) &&
    isEventsOnceCloseOrExitCall(topParent, topExpr, scopeIndex)
  ) {
    waitsOnCloseOrExit = true;
  } else if (doesExprPassToConsumerOrEscape(topExpr)) {
    return;
  }

  function classifyStreamNode(streamNode: ts.Node, which: 'stdout' | 'stderr'): void {
    const curr = unwrapUpwardAssertions(streamNode);
    const parent = curr.parent;
    if (!parent) {
      return;
    }

    if (
      ts.isVariableDeclaration(parent) &&
      parent.initializer === curr &&
      ts.isIdentifier(parent.name)
    ) {
      if (isExportedVariableDeclaration(parent)) {
        if (which === 'stdout') stdoutRead = true;
        else stderrRead = true;
        return;
      }
      if (which === 'stdout') {
        stdoutDecls.add(parent);
      } else {
        stderrDecls.add(parent);
      }
      return;
    }

    if (ts.isPropertyAccessExpression(parent) && parent.expression === curr) {
      const method = parent.name.text;
      if (
        parent.parent &&
        ts.isCallExpression(parent.parent) &&
        parent.parent.expression === parent
      ) {
        const methodCall = parent.parent;
        if (method === 'on' || method === 'once' || method === 'addListener') {
          if (isDataOrReadableEventArg(methodCall.arguments[0], scopeIndex)) {
            if (which === 'stdout') stdoutRead = true;
            else stderrRead = true;
          }
          if (method === 'on' || method === 'once' || method === 'addListener') {
            classifyStreamNode(methodCall, which);
          }
          return;
        }
        if (STREAM_CONSUMING_METHODS.has(method)) {
          if (which === 'stdout') stdoutRead = true;
          else stderrRead = true;
          return;
        }
        if (method === 'setEncoding' || method === 'pause') {
          classifyStreamNode(methodCall, which);
          return;
        }
      }
      return;
    }

    if (
      ts.isElementAccessExpression(parent) &&
      parent.expression === curr &&
      parent.parent &&
      ts.isCallExpression(parent.parent) &&
      parent.parent.expression === parent
    ) {
      if (which === 'stdout') stdoutRead = true;
      else stderrRead = true;
      return;
    }

    if (doesExprPassToConsumerOrEscape(curr)) {
      if (which === 'stdout') stdoutRead = true;
      else stderrRead = true;
    }
  }

  function classifyChildOutcomeNode(exprNode: ts.Node): void {
    const curr = unwrapUpwardAssertions(exprNode);
    const parent = curr.parent;
    if (!parent) {
      return;
    }

    if (ts.isVariableDeclaration(parent) && parent.initializer === curr) {
      if (isExportedVariableDeclaration(parent)) {
        escaped = true;
        return;
      }
      if (ts.isIdentifier(parent.name)) {
        childDecls.add(parent);
        return;
      }
      if (ts.isObjectBindingPattern(parent.name)) {
        for (const el of parent.name.elements) {
          if (el.dotDotDotToken) {
            escaped = true;
            return;
          }
          const propNode = el.propertyName ?? el.name;
          if (ts.isIdentifier(propNode) && ts.isIdentifier(el.name)) {
            if (propNode.text === 'stdout') {
              stdoutDecls.add(el.name);
            } else if (propNode.text === 'stderr') {
              stderrDecls.add(el.name);
            }
          }
        }
        return;
      }
      escaped = true;
      return;
    }

    if (ts.isPropertyAccessExpression(parent) && parent.expression === curr) {
      const prop = parent.name.text;
      if (prop === 'stdout' || prop === 'stderr') {
        classifyStreamNode(parent, prop);
        return;
      }
      if (prop === 'stdio') {
        const stdioWrapped = unwrapUpwardAssertions(parent);
        const stdioParent = stdioWrapped.parent;
        if (
          stdioParent &&
          ts.isElementAccessExpression(stdioParent) &&
          stdioParent.expression === stdioWrapped
        ) {
          const idxNum = evalStaticNumber(stdioParent.argumentExpression, scopeIndex);
          if (idxNum === 1) {
            classifyStreamNode(stdioParent, 'stdout');
            return;
          }
          if (idxNum === 2) {
            classifyStreamNode(stdioParent, 'stderr');
            return;
          }
        }
        if (doesExprPassToConsumerOrEscape(stdioWrapped)) {
          stdoutRead = true;
          stderrRead = true;
        }
        return;
      }
      if (prop === 'on' || prop === 'once' || prop === 'addListener') {
        if (
          parent.parent &&
          ts.isCallExpression(parent.parent) &&
          parent.parent.expression === parent
        ) {
          const evCall = parent.parent;
          if (isCloseOrExitEventArg(evCall.arguments[0], scopeIndex)) {
            waitsOnCloseOrExit = true;
          }
          classifyChildOutcomeNode(evCall);
          return;
        }
      }
      return;
    }

    if (ts.isCallExpression(parent)) {
      for (const arg of parent.arguments) {
        if (arg === curr || unwrapUpwardAssertions(arg) === curr) {
          if (isEventsOnceCloseOrExitCall(parent, curr, scopeIndex)) {
            waitsOnCloseOrExit = true;
          } else {
            escaped = true;
          }
          return;
        }
      }
    }

    if (ts.isNewExpression(parent) && parent.arguments) {
      for (const arg of parent.arguments) {
        if (arg === curr || unwrapUpwardAssertions(arg) === curr) {
          escaped = true;
          return;
        }
      }
    }

    if (ts.isReturnStatement(parent) && parent.expression === curr) {
      escaped = true;
      return;
    }

    if (ts.isArrowFunction(parent) && parent.body === curr) {
      escaped = true;
      return;
    }

    if (
      ts.isObjectLiteralExpression(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isShorthandPropertyAssignment(parent) ||
      ts.isSpreadAssignment(parent) ||
      ts.isArrayLiteralExpression(parent) ||
      ts.isSpreadElement(parent)
    ) {
      if (ts.isShorthandPropertyAssignment(parent) || ts.isPropertyAssignment(parent)) {
        escaped = true;
        return;
      }
      escaped = true;
      return;
    }

    if (ts.isBinaryExpression(parent)) {
      const op = parent.operatorToken.kind;
      if (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment) {
        if (parent.right === curr) {
          if (ts.isIdentifier(parent.left)) {
            const targetDecl = getBindingIdentifierDeclNode(parent.left, scopeIndex);
            if (targetDecl && analysisRoot) {
              const targetScope = scopeIndex.resolveDeclarationScope(
                parent.left,
                parent.left.text
              );
              if (targetScope && analysisRoot === targetScope.astNode) {
                childDecls.add(targetDecl);
                return;
              }
            }
          }
          escaped = true;
        }
        return;
      }
      if (
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.QuestionQuestionToken ||
        op === ts.SyntaxKind.AmpersandAmpersandToken
      ) {
        classifyChildOutcomeNode(parent);
      }
      return;
    }

    if (ts.isConditionalExpression(parent) && parent.condition !== curr) {
      classifyChildOutcomeNode(parent);
    }
  }

  if (analysisRoot) {
    const allIdentifiers: ts.Identifier[] = [];
    function collectIds(n: ts.Node): void {
      if (ts.isIdentifier(n) && isIdentifierReferenceSite(n)) {
        allIdentifiers.push(n);
      }
      ts.forEachChild(n, collectIds);
    }
    collectIds(analysisRoot);

    let prevSizes = -1;
    while (
      !escaped &&
      prevSizes !== childDecls.size + stdoutDecls.size + stderrDecls.size
    ) {
      prevSizes = childDecls.size + stdoutDecls.size + stderrDecls.size;
      for (const id of allIdentifiers) {
        if (escaped) {
          break;
        }
        const declNode = getBindingIdentifierDeclNode(id, scopeIndex);
        if (!declNode) {
          continue;
        }
        if (childDecls.has(declNode)) {
          classifyChildOutcomeNode(id);
        } else if (stdoutDecls.has(declNode)) {
          classifyStreamNode(id, 'stdout');
        } else if (stderrDecls.has(declNode)) {
          classifyStreamNode(id, 'stderr');
        }
      }
    }
  }

  if (escaped || !waitsOnCloseOrExit) {
    return;
  }

  const unread: string[] = [];
  if (stdoutPiped && !stdoutRead) {
    unread.push('stdout');
  }
  if (stderrPiped && !stderrRead) {
    unread.push('stderr');
  }

  if (unread.length === 0) {
    return;
  }

  const streamLabel = unread.join(' and ');
  findings.push(
    createFinding(
      sourceFile,
      displayPath,
      spawnCall,
      'CPG002',
      `spawn() leaves piped ${streamLabel} unread while waiting on close/exit, risking an OS pipe buffer deadlock.`
    )
  );
}

function isProcessPlatformExpr(rawExpr: ts.Expression): boolean {
  const expr = unwrapExpr(rawExpr);
  if (!ts.isPropertyAccessExpression(expr) || expr.name.text !== 'platform') {
    return false;
  }
  const recv = unwrapExpr(expr.expression);
  if (ts.isIdentifier(recv) && recv.text === 'process') {
    return true;
  }
  if (
    ts.isPropertyAccessExpression(recv) &&
    recv.name.text === 'process' &&
    ts.isIdentifier(unwrapExpr(recv.expression)) &&
    (unwrapExpr(recv.expression) as ts.Identifier).text === 'globalThis'
  ) {
    return true;
  }
  return false;
}

function isWin32EqualityExpr(
  rawExpr: ts.Expression,
  scopeIndex: ScopeIndex,
  visited: Set<ts.Node> = new Set()
): boolean {
  const expr = unwrapExpr(rawExpr);
  if (ts.isIdentifier(expr)) {
    const b = scopeIndex.lookup(expr, expr.text);
    if (
      b?.kind === 'local' &&
      (b.isConst || !b.mutated) &&
      b.initializer &&
      !visited.has(b.declNode)
    ) {
      visited.add(b.declNode);
      return isWin32EqualityExpr(b.initializer, scopeIndex, visited);
    }
    return false;
  }
  if (
    ts.isBinaryExpression(expr) &&
    (expr.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      expr.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken)
  ) {
    const left = unwrapExpr(expr.left);
    const right = unwrapExpr(expr.right);
    if (
      isProcessPlatformExpr(left) &&
      ts.isStringLiteralLike(right) &&
      right.text === 'win32'
    ) {
      return true;
    }
    if (
      isProcessPlatformExpr(right) &&
      ts.isStringLiteralLike(left) &&
      left.text === 'win32'
    ) {
      return true;
    }
  }
  return false;
}

const POSIX_PLATFORMS = new Set<string>([
  'linux',
  'darwin',
  'freebsd',
  'openbsd',
  'aix',
  'sunos',
]);

function isDetachedEnabledExpr(
  rawExpr: ts.Expression,
  scopeIndex: ScopeIndex,
  visited: Set<ts.Node> = new Set()
): boolean {
  const expr = unwrapExpr(rawExpr);
  if (expr.kind === ts.SyntaxKind.TrueKeyword) {
    return true;
  }
  if (expr.kind === ts.SyntaxKind.FalseKeyword) {
    return false;
  }
  if (ts.isIdentifier(expr)) {
    const b = scopeIndex.lookup(expr, expr.text);
    if (
      b?.kind === 'local' &&
      (b.isConst || !b.mutated) &&
      b.initializer &&
      !visited.has(b.declNode)
    ) {
      visited.add(b.declNode);
      return isDetachedEnabledExpr(b.initializer, scopeIndex, visited);
    }
    return false;
  }
  if (
    ts.isPrefixUnaryExpression(expr) &&
    expr.operator === ts.SyntaxKind.ExclamationToken
  ) {
    return isWin32EqualityExpr(expr.operand, scopeIndex, visited);
  }
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    const left = unwrapExpr(expr.left);
    const right = unwrapExpr(expr.right);
    if (
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken
    ) {
      if (
        (isProcessPlatformExpr(left) &&
          ts.isStringLiteralLike(right) &&
          right.text === 'win32') ||
        (isProcessPlatformExpr(right) &&
          ts.isStringLiteralLike(left) &&
          left.text === 'win32')
      ) {
        return true;
      }
    }
    if (
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsToken
    ) {
      if (
        (isProcessPlatformExpr(left) &&
          ts.isStringLiteralLike(right) &&
          POSIX_PLATFORMS.has(right.text)) ||
        (isProcessPlatformExpr(right) &&
          ts.isStringLiteralLike(left) &&
          POSIX_PLATFORMS.has(left.text))
      ) {
        return true;
      }
    }
  }
  if (ts.isConditionalExpression(expr)) {
    return (
      isDetachedEnabledExpr(expr.whenTrue, scopeIndex, visited) ||
      isDetachedEnabledExpr(expr.whenFalse, scopeIndex, visited)
    );
  }
  return false;
}

function isSpawnDetached(
  optionsExpr: ts.Expression | undefined,
  scopeIndex: ScopeIndex
): boolean {
  if (!optionsExpr) {
    return false;
  }
  const resolved = resolveSingleValueExpr(optionsExpr, scopeIndex);
  if (!ts.isObjectLiteralExpression(resolved)) {
    return false;
  }
  const { props } = extractObjectProperties(resolved, scopeIndex);
  const detachedProp = props.get('detached');
  if (!detachedProp) {
    return false;
  }
  return isDetachedEnabledExpr(detachedProp, scopeIndex);
}

function isNegatedPidExpr(
  rawExpr: ts.Expression,
  scopeIndex: ScopeIndex,
  visited: Set<ts.Node> = new Set()
): boolean {
  const expr = unwrapExpr(rawExpr);
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.MinusToken) {
    return true;
  }
  if (ts.isBinaryExpression(expr)) {
    if (expr.operatorToken.kind === ts.SyntaxKind.MinusToken) {
      const leftNum = evalStaticNumber(expr.left, scopeIndex);
      if (leftNum === 0) {
        return true;
      }
    }
    if (expr.operatorToken.kind === ts.SyntaxKind.AsteriskToken) {
      const leftNum = evalStaticNumber(expr.left, scopeIndex);
      const rightNum = evalStaticNumber(expr.right, scopeIndex);
      if (leftNum === -1 || rightNum === -1) {
        return true;
      }
    }
  }
  if (ts.isIdentifier(expr)) {
    const b = scopeIndex.lookup(expr, expr.text);
    if (
      b?.kind === 'local' &&
      (b.isConst || !b.mutated) &&
      b.initializer &&
      !visited.has(b.declNode)
    ) {
      visited.add(b.declNode);
      return isNegatedPidExpr(b.initializer, scopeIndex, visited);
    }
  }
  return false;
}

function isProcessKillNegativeCall(
  callExpr: ts.CallExpression,
  scopeIndex: ScopeIndex
): boolean {
  if (callExpr.arguments.length < 1) {
    return false;
  }
  const callee = unwrapExpr(callExpr.expression);
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'kill') {
    return false;
  }
  const recv = unwrapExpr(callee.expression);
  const isProcess =
    (ts.isIdentifier(recv) &&
      recv.text === 'process' &&
      scopeIndex.lookup(recv, 'process') === undefined) ||
    (ts.isPropertyAccessExpression(recv) &&
      recv.name.text === 'process' &&
      ts.isIdentifier(unwrapExpr(recv.expression)) &&
      (unwrapExpr(recv.expression) as ts.Identifier).text === 'globalThis');

  if (!isProcess) {
    return false;
  }
  return isNegatedPidExpr(callExpr.arguments[0], scopeIndex);
}

function isTreeKillInvocation(callExpr: ts.CallExpression, scopeIndex: ScopeIndex): boolean {
  const scope = scopeIndex.getScopeForNode(callExpr);
  if (isTreeKillRef(callExpr.expression, scope)) {
    return true;
  }
  const callee = unwrapExpr(callExpr.expression);
  if (ts.isIdentifier(callee) && callee.text === 'treeKill') {
    return true;
  }
  return false;
}

function subtreeHasDirectGroupOrTreeKill(root: ts.Node, scopeIndex: ScopeIndex): boolean {
  let found = false;
  function walk(n: ts.Node): void {
    if (found) {
      return;
    }
    if (
      ts.isCallExpression(n) &&
      (isProcessKillNegativeCall(n, scopeIndex) || isTreeKillInvocation(n, scopeIndex))
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, walk);
  }
  walk(root);
  return found;
}

function scopeHasGroupOrTreeKill(
  containerScopeNode: ts.Node,
  scopeIndex: ScopeIndex
): boolean {
  if (subtreeHasDirectGroupOrTreeKill(containerScopeNode, scopeIndex)) {
    return true;
  }

  let callsHelperWithGroupKill = false;
  function walkCalls(n: ts.Node): void {
    if (callsHelperWithGroupKill) {
      return;
    }
    if (ts.isCallExpression(n)) {
      const callee = unwrapExpr(n.expression);
      if (ts.isIdentifier(callee)) {
        const b = scopeIndex.lookup(callee, callee.text);
        if (b?.kind === 'functionDecl' && subtreeHasDirectGroupOrTreeKill(b.declNode, scopeIndex)) {
          callsHelperWithGroupKill = true;
          return;
        }
        if (
          b?.kind === 'local' &&
          b.initializer &&
          (ts.isArrowFunction(unwrapExpr(b.initializer)) ||
            ts.isFunctionExpression(unwrapExpr(b.initializer))) &&
          subtreeHasDirectGroupOrTreeKill(b.initializer, scopeIndex)
        ) {
          callsHelperWithGroupKill = true;
          return;
        }
      }
    }
    ts.forEachChild(n, walkCalls);
  }
  walkCalls(containerScopeNode);
  return callsHelperWithGroupKill;
}

function findEnclosingClass(node: ts.Node): ts.ClassLikeDeclaration | undefined {
  let curr: ts.Node | undefined = node.parent;
  while (curr) {
    if (ts.isClassDeclaration(curr) || ts.isClassExpression(curr)) {
      return curr;
    }
    curr = curr.parent;
  }
  return undefined;
}

function checkCpg003(
  sourceFile: ts.SourceFile,
  displayPath: string,
  spawnCall: ts.CallExpression,
  scopeIndex: ScopeIndex,
  findings: Finding[]
): void {
  const spawnOptions = locateSpawnOptions(spawnCall.arguments, scopeIndex);
  if (!isSpawnDetached(spawnOptions, scopeIndex)) {
    return;
  }

  let topExpr: ts.Node = unwrapUpwardAssertions(spawnCall);
  while (
    topExpr.parent &&
    ts.isPropertyAccessExpression(topExpr.parent) &&
    topExpr.parent.expression === topExpr &&
    (topExpr.parent.name.text === 'on' ||
      topExpr.parent.name.text === 'once' ||
      topExpr.parent.name.text === 'addListener') &&
    topExpr.parent.parent &&
    ts.isCallExpression(topExpr.parent.parent) &&
    topExpr.parent.parent.expression === topExpr.parent
  ) {
    topExpr = unwrapUpwardAssertions(topExpr.parent.parent);
  }

  const topParent = topExpr.parent;
  if (!topParent) {
    return;
  }

  if (
    ts.isPropertyAccessExpression(topParent) &&
    topParent.expression === topExpr &&
    topParent.name.text === 'kill' &&
    topParent.parent &&
    ts.isCallExpression(topParent.parent) &&
    topParent.parent.expression === topParent
  ) {
    const container = enclosingFunctionOrSource(spawnCall);
    if (!scopeHasGroupOrTreeKill(container, scopeIndex)) {
      findings.push(
        createFinding(
          sourceFile,
          displayPath,
          topParent.parent,
          'CPG003',
          'Detached child process killed via child.kill() without process.kill(-pid) or tree-kill, leaving process-group descendants running.'
        )
      );
    }
    return;
  }

  const childDecls = new Set<ts.Node>();
  let trackedClassProp: string | undefined;
  let containerRoot: ts.Node | undefined;

  if (
    ts.isVariableDeclaration(topParent) &&
    topParent.initializer === topExpr &&
    ts.isIdentifier(topParent.name)
  ) {
    childDecls.add(topParent);
    const declScope = scopeIndex.resolveDeclarationScope(topParent.name, topParent.name.text);
    containerRoot = declScope ? declScope.astNode : enclosingFunctionOrSource(spawnCall);
  } else if (
    ts.isBinaryExpression(topParent) &&
    topParent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    topParent.right === topExpr
  ) {
    const lhs = unwrapExpr(topParent.left);
    if (ts.isIdentifier(lhs)) {
      const targetDecl = getBindingIdentifierDeclNode(lhs, scopeIndex);
      const declScope = scopeIndex.resolveDeclarationScope(lhs, lhs.text);
      if (targetDecl && declScope) {
        childDecls.add(targetDecl);
        containerRoot = declScope.astNode;
      }
    } else if (
      ts.isPropertyAccessExpression(lhs) &&
      lhs.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      const cls = findEnclosingClass(spawnCall);
      if (cls) {
        trackedClassProp = lhs.name.text;
        containerRoot = cls;
      }
    }
  }

  if (!containerRoot) {
    return;
  }

  let prevSize = -1;
  while (prevSize !== childDecls.size) {
    prevSize = childDecls.size;
    const expandAliases = (n: ts.Node): void => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.initializer
      ) {
        const init = unwrapExpr(n.initializer);
        if (ts.isIdentifier(init)) {
          const decl = getBindingIdentifierDeclNode(init, scopeIndex);
          if (decl && childDecls.has(decl)) {
            childDecls.add(n);
          }
        } else if (
          trackedClassProp !== undefined &&
          ts.isPropertyAccessExpression(init) &&
          init.expression.kind === ts.SyntaxKind.ThisKeyword &&
          init.name.text === trackedClassProp
        ) {
          childDecls.add(n);
        }
      }
      ts.forEachChild(n, expandAliases);
    };
    expandAliases(containerRoot);
  }

  let firstKillCall: ts.CallExpression | undefined;
  function findFirstKillCall(n: ts.Node): void {
    if (firstKillCall) {
      return;
    }
    if (ts.isCallExpression(n)) {
      const callee = unwrapExpr(n.expression);
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'kill') {
        const recv = unwrapExpr(callee.expression);
        if (ts.isIdentifier(recv) && isIdentifierReferenceSite(recv)) {
          const decl = getBindingIdentifierDeclNode(recv, scopeIndex);
          if (decl && childDecls.has(decl)) {
            firstKillCall = n;
            return;
          }
        } else if (
          trackedClassProp !== undefined &&
          ts.isPropertyAccessExpression(recv) &&
          recv.expression.kind === ts.SyntaxKind.ThisKeyword &&
          recv.name.text === trackedClassProp
        ) {
          firstKillCall = n;
          return;
        }
      }
    }
    ts.forEachChild(n, findFirstKillCall);
  }
  findFirstKillCall(containerRoot);

  if (!firstKillCall) {
    return;
  }

  if (!scopeHasGroupOrTreeKill(containerRoot, scopeIndex)) {
    findings.push(
      createFinding(
        sourceFile,
        displayPath,
        firstKillCall,
        'CPG003',
        'Detached child process killed via child.kill() without process.kill(-pid) or tree-kill, leaving process-group descendants running.'
      )
    );
  }
}

export function analyzeSourceFile(source: SourceInput): Finding[] {
  const sourceFile = ts.createSourceFile(
    source.displayPath,
    source.content,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(source.displayPath)
  );

  const scopeIndex = buildScopeIndex(sourceFile);
  const findings: Finding[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const scope = scopeIndex.getScopeForNode(node);
      const cpFn = resolveCpFunctionRef(node.expression, scope);
      if (cpFn !== undefined && cpFn !== 'fork') {
        if (cpFn === 'spawn') {
          checkCpg002(sourceFile, source.displayPath, node, scopeIndex, findings);
          checkCpg003(sourceFile, source.displayPath, node, scopeIndex, findings);
        } else {
          checkCpg001(sourceFile, source.displayPath, node, cpFn, scopeIndex, findings);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  findings.sort((a, b) => {
    if (a.line !== b.line) return a.line - b.line;
    if (a.column !== b.column) return a.column - b.column;
    return a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0;
  });

  return findings;
}

export function analyzeSources(
  sources: readonly SourceInput[],
  _options: AnalyzerOptions = {}
): Finding[] {
  const allFindings: Finding[] = [];
  for (const source of sources) {
    const fileFindings = analyzeSourceFile(source);
    for (const f of fileFindings) {
      allFindings.push(f);
    }
  }
  allFindings.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    if (a.column !== b.column) return a.column - b.column;
    return a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0;
  });
  return allFindings;
}
