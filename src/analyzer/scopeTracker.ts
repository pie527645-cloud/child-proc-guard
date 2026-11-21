import ts from 'typescript';

export type BaseCpFunctionName =
  | 'exec'
  | 'execFile'
  | 'execSync'
  | 'execFileSync'
  | 'spawn'
  | 'spawnSync'
  | 'fork';

export type CpFunctionKind =
  | BaseCpFunctionName
  | 'promisified_exec'
  | 'promisified_execFile';

export type SymbolBinding =
  | { readonly kind: 'cpNamespace' }
  | { readonly kind: 'cpFunction'; readonly fn: CpFunctionKind }
  | { readonly kind: 'utilNamespace' }
  | { readonly kind: 'utilPromisify' }
  | { readonly kind: 'eventsNamespace' }
  | { readonly kind: 'eventsOnce' }
  | { readonly kind: 'treeKill' }
  | {
      readonly kind: 'local';
      readonly declNode: ts.VariableDeclaration;
      readonly isConst: boolean;
      readonly initializer?: ts.Expression;
      readonly typeNode?: ts.TypeNode;
      mutated: boolean;
    }
  | {
      readonly kind: 'functionDecl';
      readonly declNode: ts.FunctionLikeDeclaration;
    }
  | {
      readonly kind: 'shadowed';
      readonly declNode?: ts.Node;
      readonly typeNode?: ts.TypeNode;
    };

export interface Scope {
  readonly astNode: ts.Node;
  readonly parent?: Scope;
  readonly bindings: Map<string, SymbolBinding>;
}

export interface ScopeIndex {
  readonly rootScope: Scope;
  getScopeForNode(node: ts.Node): Scope;
  lookup(node: ts.Node, name: string): SymbolBinding | undefined;
  resolveDeclarationScope(node: ts.Node, name: string): Scope | undefined;
}

const CP_FUNCTION_NAMES: ReadonlySet<string> = new Set<BaseCpFunctionName>([
  'exec',
  'execFile',
  'execSync',
  'execFileSync',
  'spawn',
  'spawnSync',
  'fork',
]);

function isBaseCpFunctionName(name: string): name is BaseCpFunctionName {
  return CP_FUNCTION_NAMES.has(name);
}

export function isChildProcessSpecifier(specifier: string): boolean {
  return specifier === 'child_process' || specifier === 'node:child_process';
}

export function isUtilSpecifier(specifier: string): boolean {
  return specifier === 'util' || specifier === 'node:util';
}

export function isEventsSpecifier(specifier: string): boolean {
  return specifier === 'events' || specifier === 'node:events';
}

export function isTreeKillSpecifier(specifier: string): boolean {
  return specifier === 'tree-kill';
}

export function unwrapExpr(expr: ts.Expression): ts.Expression {
  let curr = expr;
  while (true) {
    if (ts.isParenthesizedExpression(curr)) {
      curr = curr.expression;
      continue;
    }
    if (ts.isAsExpression(curr) || ts.isSatisfiesExpression(curr) || ts.isTypeAssertionExpression(curr)) {
      curr = curr.expression;
      continue;
    }
    if (ts.isNonNullExpression(curr)) {
      curr = curr.expression;
      continue;
    }
    return curr;
  }
}

function unwrapAwaitAndAssertions(expr: ts.Expression): ts.Expression {
  let curr = unwrapExpr(expr);
  while (ts.isAwaitExpression(curr)) {
    curr = unwrapExpr(curr.expression);
  }
  return curr;
}

function isScopeCreatingNode(node: ts.Node): boolean {
  return (
    ts.isSourceFile(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isBlock(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isCatchClause(node) ||
    ts.isModuleBlock(node) ||
    ts.isCaseBlock(node)
  );
}

function isFunctionOrSourceScopeNode(node: ts.Node): boolean {
  return (
    ts.isSourceFile(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isModuleBlock(node)
  );
}

function lookupInScopeChain(scope: Scope | undefined, name: string): SymbolBinding | undefined {
  let curr = scope;
  while (curr !== undefined) {
    const found = curr.bindings.get(name);
    if (found !== undefined) {
      return found;
    }
    curr = curr.parent;
  }
  return undefined;
}

function findDeclaringScopeInChain(scope: Scope | undefined, name: string): Scope | undefined {
  let curr = scope;
  while (curr !== undefined) {
    if (curr.bindings.has(name)) {
      return curr;
    }
    curr = curr.parent;
  }
  return undefined;
}

function nearestFunctionOrSourceScope(scope: Scope): Scope {
  let curr: Scope = scope;
  while (curr.parent !== undefined && !isFunctionOrSourceScopeNode(curr.astNode)) {
    curr = curr.parent;
  }
  return curr;
}

export function getModuleLoadSpecifier(
  rawExpr: ts.Expression,
  scope: Scope
): string | undefined {
  const expr = unwrapAwaitAndAssertions(rawExpr);
  if (!ts.isCallExpression(expr) || expr.arguments.length !== 1) {
    return undefined;
  }
  const arg0 = unwrapExpr(expr.arguments[0]);
  if (!ts.isStringLiteralLike(arg0)) {
    return undefined;
  }

  const callee = unwrapExpr(expr.expression);
  if (ts.isIdentifier(callee) && callee.text === 'require') {
    if (lookupInScopeChain(scope, 'require') !== undefined) {
      return undefined;
    }
    return arg0.text;
  }
  if (callee.kind === ts.SyntaxKind.ImportKeyword) {
    return arg0.text;
  }
  return undefined;
}

function getMemberPropertyName(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression
): string | undefined {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text;
  }
  const arg = unwrapExpr(node.argumentExpression);
  if (ts.isStringLiteralLike(arg)) {
    return arg.text;
  }
  return undefined;
}

export function isCpNamespaceExpr(rawExpr: ts.Expression, scope: Scope): boolean {
  const expr = unwrapAwaitAndAssertions(rawExpr);
  if (ts.isIdentifier(expr)) {
    const b = lookupInScopeChain(scope, expr.text);
    return b?.kind === 'cpNamespace';
  }
  const spec = getModuleLoadSpecifier(expr, scope);
  return spec !== undefined && isChildProcessSpecifier(spec);
}

export function isUtilNamespaceExpr(rawExpr: ts.Expression, scope: Scope): boolean {
  const expr = unwrapAwaitAndAssertions(rawExpr);
  if (ts.isIdentifier(expr)) {
    const b = lookupInScopeChain(scope, expr.text);
    return b?.kind === 'utilNamespace';
  }
  const spec = getModuleLoadSpecifier(expr, scope);
  return spec !== undefined && isUtilSpecifier(spec);
}

export function isEventsNamespaceExpr(rawExpr: ts.Expression, scope: Scope): boolean {
  const expr = unwrapAwaitAndAssertions(rawExpr);
  if (ts.isIdentifier(expr)) {
    const b = lookupInScopeChain(scope, expr.text);
    return b?.kind === 'eventsNamespace';
  }
  const spec = getModuleLoadSpecifier(expr, scope);
  return spec !== undefined && isEventsSpecifier(spec);
}

export function isUtilPromisifyCallee(rawExpr: ts.Expression, scope: Scope): boolean {
  const expr = unwrapExpr(rawExpr);
  if (ts.isIdentifier(expr)) {
    const b = lookupInScopeChain(scope, expr.text);
    return b?.kind === 'utilPromisify';
  }
  if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
    const prop = getMemberPropertyName(expr);
    if (prop === 'promisify' && isUtilNamespaceExpr(expr.expression, scope)) {
      return true;
    }
  }
  return false;
}

export function resolveCpFunctionRef(
  rawExpr: ts.Expression,
  scope: Scope
): CpFunctionKind | undefined {
  const expr = unwrapExpr(rawExpr);

  if (ts.isIdentifier(expr)) {
    const b = lookupInScopeChain(scope, expr.text);
    if (b?.kind === 'cpFunction') {
      return b.fn;
    }
    return undefined;
  }

  if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
    const prop = getMemberPropertyName(expr);
    if (prop !== undefined && isBaseCpFunctionName(prop) && isCpNamespaceExpr(expr.expression, scope)) {
      return prop;
    }
    return undefined;
  }

  if (ts.isCallExpression(expr) && expr.arguments.length >= 1 && isUtilPromisifyCallee(expr.expression, scope)) {
    const innerTarget = resolveCpFunctionRef(expr.arguments[0], scope);
    if (innerTarget === 'exec') {
      return 'promisified_exec';
    }
    if (innerTarget === 'execFile') {
      return 'promisified_execFile';
    }
  }

  return undefined;
}

export function isTreeKillRef(rawExpr: ts.Expression, scope: Scope): boolean {
  const expr = unwrapAwaitAndAssertions(rawExpr);
  if (ts.isIdentifier(expr)) {
    const b = lookupInScopeChain(scope, expr.text);
    return b?.kind === 'treeKill';
  }
  const spec = getModuleLoadSpecifier(expr, scope);
  if (spec !== undefined && isTreeKillSpecifier(spec)) {
    return true;
  }
  if (ts.isPropertyAccessExpression(expr) && expr.name.text === 'default') {
    return isTreeKillRef(expr.expression, scope);
  }
  if (ts.isCallExpression(expr) && expr.arguments.length >= 1 && isUtilPromisifyCallee(expr.expression, scope)) {
    return isTreeKillRef(expr.arguments[0], scope);
  }
  return false;
}

function bindDestructuredPatternAsShadowed(nameNode: ts.BindingName, scope: Scope): void {
  if (ts.isIdentifier(nameNode)) {
    scope.bindings.set(nameNode.text, { kind: 'shadowed', declNode: nameNode });
    return;
  }
  for (const element of nameNode.elements) {
    if (ts.isOmittedExpression(element)) {
      continue;
    }
    bindDestructuredPatternAsShadowed(element.name, scope);
  }
}

function handleImportDeclaration(node: ts.ImportDeclaration, rootScope: Scope): void {
  const clause = node.importClause;
  if (!clause || clause.isTypeOnly) {
    return;
  }
  if (!ts.isStringLiteralLike(node.moduleSpecifier)) {
    return;
  }
  const spec = node.moduleSpecifier.text;

  if (isChildProcessSpecifier(spec)) {
    if (clause.name) {
      rootScope.bindings.set(clause.name.text, { kind: 'cpNamespace' });
    }
    const bindings = clause.namedBindings;
    if (bindings) {
      if (ts.isNamespaceImport(bindings)) {
        rootScope.bindings.set(bindings.name.text, { kind: 'cpNamespace' });
      } else if (ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          if (el.isTypeOnly) {
            continue;
          }
          const importedName = (el.propertyName ?? el.name).text;
          if (isBaseCpFunctionName(importedName)) {
            rootScope.bindings.set(el.name.text, { kind: 'cpFunction', fn: importedName });
          } else {
            rootScope.bindings.set(el.name.text, { kind: 'shadowed', declNode: el });
          }
        }
      }
    }
    return;
  }

  if (isUtilSpecifier(spec)) {
    if (clause.name) {
      rootScope.bindings.set(clause.name.text, { kind: 'utilNamespace' });
    }
    const bindings = clause.namedBindings;
    if (bindings) {
      if (ts.isNamespaceImport(bindings)) {
        rootScope.bindings.set(bindings.name.text, { kind: 'utilNamespace' });
      } else if (ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          if (el.isTypeOnly) {
            continue;
          }
          const importedName = (el.propertyName ?? el.name).text;
          if (importedName === 'promisify') {
            rootScope.bindings.set(el.name.text, { kind: 'utilPromisify' });
          } else {
            rootScope.bindings.set(el.name.text, { kind: 'shadowed', declNode: el });
          }
        }
      }
    }
    return;
  }

  if (isEventsSpecifier(spec)) {
    if (clause.name) {
      rootScope.bindings.set(clause.name.text, { kind: 'eventsNamespace' });
    }
    const bindings = clause.namedBindings;
    if (bindings) {
      if (ts.isNamespaceImport(bindings)) {
        rootScope.bindings.set(bindings.name.text, { kind: 'eventsNamespace' });
      } else if (ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          if (el.isTypeOnly) {
            continue;
          }
          const importedName = (el.propertyName ?? el.name).text;
          if (importedName === 'once') {
            rootScope.bindings.set(el.name.text, { kind: 'eventsOnce' });
          } else {
            rootScope.bindings.set(el.name.text, { kind: 'shadowed', declNode: el });
          }
        }
      }
    }
    return;
  }

  if (isTreeKillSpecifier(spec)) {
    if (clause.name) {
      rootScope.bindings.set(clause.name.text, { kind: 'treeKill' });
    }
    const bindings = clause.namedBindings;
    if (bindings) {
      if (ts.isNamespaceImport(bindings)) {
        rootScope.bindings.set(bindings.name.text, { kind: 'treeKill' });
      } else if (ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          if (!el.isTypeOnly) {
            rootScope.bindings.set(el.name.text, { kind: 'treeKill' });
          }
        }
      }
    }
    return;
  }

  if (clause.name) {
    rootScope.bindings.set(clause.name.text, { kind: 'shadowed', declNode: clause });
  }
  const bindings = clause.namedBindings;
  if (bindings) {
    if (ts.isNamespaceImport(bindings)) {
      rootScope.bindings.set(bindings.name.text, { kind: 'shadowed', declNode: bindings });
    } else if (ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        if (!el.isTypeOnly) {
          rootScope.bindings.set(el.name.text, { kind: 'shadowed', declNode: el });
        }
      }
    }
  }
}

function handleImportEqualsDeclaration(node: ts.ImportEqualsDeclaration, targetScope: Scope): void {
  if (node.isTypeOnly) {
    return;
  }
  if (
    ts.isExternalModuleReference(node.moduleReference) &&
    node.moduleReference.expression &&
    ts.isStringLiteralLike(node.moduleReference.expression)
  ) {
    const spec = node.moduleReference.expression.text;
    if (isChildProcessSpecifier(spec)) {
      targetScope.bindings.set(node.name.text, { kind: 'cpNamespace' });
      return;
    }
    if (isUtilSpecifier(spec)) {
      targetScope.bindings.set(node.name.text, { kind: 'utilNamespace' });
      return;
    }
    if (isEventsSpecifier(spec)) {
      targetScope.bindings.set(node.name.text, { kind: 'eventsNamespace' });
      return;
    }
    if (isTreeKillSpecifier(spec)) {
      targetScope.bindings.set(node.name.text, { kind: 'treeKill' });
      return;
    }
  }
  targetScope.bindings.set(node.name.text, { kind: 'shadowed', declNode: node });
}

function handleVariableDeclaration(
  decl: ts.VariableDeclaration,
  declListFlags: ts.NodeFlags,
  currentScope: Scope
): void {
  const isBlockScoped =
    (declListFlags & ts.NodeFlags.Const) !== 0 || (declListFlags & ts.NodeFlags.Let) !== 0;
  const isConst = (declListFlags & ts.NodeFlags.Const) !== 0;
  const targetScope = isBlockScoped ? currentScope : nearestFunctionOrSourceScope(currentScope);

  if (decl.initializer) {
    const init = decl.initializer;

    if (isCpNamespaceExpr(init, currentScope)) {
      if (ts.isIdentifier(decl.name)) {
        targetScope.bindings.set(decl.name.text, { kind: 'cpNamespace' });
        return;
      }
      if (ts.isObjectBindingPattern(decl.name)) {
        for (const el of decl.name.elements) {
          const propNameNode = el.propertyName ?? el.name;
          if (ts.isIdentifier(propNameNode) && ts.isIdentifier(el.name)) {
            if (isBaseCpFunctionName(propNameNode.text)) {
              targetScope.bindings.set(el.name.text, {
                kind: 'cpFunction',
                fn: propNameNode.text,
              });
            } else {
              targetScope.bindings.set(el.name.text, { kind: 'shadowed', declNode: el });
            }
          } else {
            bindDestructuredPatternAsShadowed(el.name, targetScope);
          }
        }
        return;
      }
    }

    if (isUtilNamespaceExpr(init, currentScope)) {
      if (ts.isIdentifier(decl.name)) {
        targetScope.bindings.set(decl.name.text, { kind: 'utilNamespace' });
        return;
      }
      if (ts.isObjectBindingPattern(decl.name)) {
        for (const el of decl.name.elements) {
          const propNameNode = el.propertyName ?? el.name;
          if (ts.isIdentifier(propNameNode) && ts.isIdentifier(el.name)) {
            if (propNameNode.text === 'promisify') {
              targetScope.bindings.set(el.name.text, { kind: 'utilPromisify' });
            } else {
              targetScope.bindings.set(el.name.text, { kind: 'shadowed', declNode: el });
            }
          } else {
            bindDestructuredPatternAsShadowed(el.name, targetScope);
          }
        }
        return;
      }
    }

    if (isEventsNamespaceExpr(init, currentScope)) {
      if (ts.isIdentifier(decl.name)) {
        targetScope.bindings.set(decl.name.text, { kind: 'eventsNamespace' });
        return;
      }
      if (ts.isObjectBindingPattern(decl.name)) {
        for (const el of decl.name.elements) {
          const propNameNode = el.propertyName ?? el.name;
          if (ts.isIdentifier(propNameNode) && ts.isIdentifier(el.name)) {
            if (propNameNode.text === 'once') {
              targetScope.bindings.set(el.name.text, { kind: 'eventsOnce' });
            } else {
              targetScope.bindings.set(el.name.text, { kind: 'shadowed', declNode: el });
            }
          } else {
            bindDestructuredPatternAsShadowed(el.name, targetScope);
          }
        }
        return;
      }
    }

    if (ts.isIdentifier(decl.name)) {
      const cpFn = resolveCpFunctionRef(init, currentScope);
      if (cpFn !== undefined) {
        targetScope.bindings.set(decl.name.text, { kind: 'cpFunction', fn: cpFn });
        return;
      }
      if (isUtilPromisifyCallee(init, currentScope)) {
        targetScope.bindings.set(decl.name.text, { kind: 'utilPromisify' });
        return;
      }
      if (isTreeKillRef(init, currentScope)) {
        targetScope.bindings.set(decl.name.text, { kind: 'treeKill' });
        return;
      }
    }
  }

  if (ts.isIdentifier(decl.name)) {
    targetScope.bindings.set(decl.name.text, {
      kind: 'local',
      declNode: decl,
      isConst,
      initializer: decl.initializer,
      typeNode: decl.type,
      mutated: false,
    });
  } else {
    bindDestructuredPatternAsShadowed(decl.name, targetScope);
  }
}

export function buildScopeIndex(sourceFile: ts.SourceFile): ScopeIndex {
  const nodeToScope = new WeakMap<ts.Node, Scope>();
  const rootScope: Scope = {
    astNode: sourceFile,
    bindings: new Map(),
  };
  nodeToScope.set(sourceFile, rootScope);

  function prebindHoistedFunctions(container: ts.Node, scope: Scope): void {
    ts.forEachChild(container, (child) => {
      if (ts.isFunctionDeclaration(child) && child.name) {
        scope.bindings.set(child.name.text, { kind: 'functionDecl', declNode: child });
      }
    });
  }

  prebindHoistedFunctions(sourceFile, rootScope);

  function visit(node: ts.Node, parentScope: Scope): void {
    let currentScope = parentScope;
    if (node !== sourceFile && isScopeCreatingNode(node)) {
      currentScope = {
        astNode: node,
        parent: parentScope,
        bindings: new Map(),
      };
      if (ts.isBlock(node) || ts.isModuleBlock(node)) {
        prebindHoistedFunctions(node, currentScope);
      }
    }
    nodeToScope.set(node, currentScope);

    if (ts.isImportDeclaration(node)) {
      handleImportDeclaration(node, rootScope);
    } else if (ts.isImportEqualsDeclaration(node)) {
      handleImportEqualsDeclaration(node, currentScope);
    } else if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)
    ) {
      if (ts.isFunctionExpression(node) && node.name) {
        currentScope.bindings.set(node.name.text, { kind: 'functionDecl', declNode: node });
      }
      for (const param of node.parameters) {
        if (ts.isIdentifier(param.name)) {
          currentScope.bindings.set(param.name.text, {
            kind: 'shadowed',
            declNode: param,
            typeNode: param.type,
          });
        } else {
          bindDestructuredPatternAsShadowed(param.name, currentScope);
        }
      }
    } else if (ts.isCatchClause(node) && node.variableDeclaration) {
      bindDestructuredPatternAsShadowed(node.variableDeclaration.name, currentScope);
    } else if (ts.isVariableDeclarationList(node)) {
      for (const decl of node.declarations) {
        handleVariableDeclaration(decl, node.flags, currentScope);
      }
    }

    ts.forEachChild(node, (child) => visit(child, currentScope));
  }

  visit(sourceFile, rootScope);

  function markMutations(node: ts.Node): void {
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (
        op >= ts.SyntaxKind.FirstAssignment &&
        op <= ts.SyntaxKind.LastAssignment &&
        ts.isIdentifier(node.left)
      ) {
        const scope = getScopeForNode(node.left);
        const binding = lookupInScopeChain(scope, node.left.text);
        if (binding?.kind === 'local') {
          binding.mutated = true;
        }
      }
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken) &&
      ts.isIdentifier(node.operand)
    ) {
      const scope = getScopeForNode(node.operand);
      const binding = lookupInScopeChain(scope, node.operand.text);
      if (binding?.kind === 'local') {
        binding.mutated = true;
      }
    }
    ts.forEachChild(node, markMutations);
  }

  function getScopeForNode(node: ts.Node): Scope {
    let curr: ts.Node | undefined = node;
    while (curr !== undefined) {
      const found = nodeToScope.get(curr);
      if (found !== undefined) {
        return found;
      }
      curr = curr.parent;
    }
    return rootScope;
  }

  markMutations(sourceFile);

  return {
    rootScope,
    getScopeForNode,
    lookup(node: ts.Node, name: string): SymbolBinding | undefined {
      return lookupInScopeChain(getScopeForNode(node), name);
    },
    resolveDeclarationScope(node: ts.Node, name: string): Scope | undefined {
      return findDeclaringScopeInChain(getScopeForNode(node), name);
    },
  };
}
