/**
 * The static capability inventory (`AS-COVER-001…003`, D35).
 *
 * `inspect` answers *what can an agent do on this page right now*. It cannot
 * answer *did we author something no scenario ever reaches*, because a surface
 * is a projection of what is mounted: a route no scenario visits registers
 * nothing, so there is nothing to report and nothing to diff. The denominator
 * has to come from somewhere that does not require mounting.
 *
 * It comes from here. A registration call site is far more static than the
 * surface it produces:
 *
 * ```tsx
 * useAgentComponent({
 *   type: "devices.table",                       // string literal
 *   actions: { sort: action({ … }) },            // capability name is a key
 * });
 * ```
 *
 * `view:devices.table.sort` is fully determined by source text. What is
 * genuinely dynamic — availability, policy outcome, binding — is the
 * *projection*, and none of it is claimed here.
 *
 * ## This creates no exposure path (directive §2.1)
 *
 * No DOM is scanned, nothing is registered, no annotation is suggested. This
 * module *reads the same reviewed registration code* a human reads and counts
 * what is already there. It lives in `@agent-surface/cli` — which no adapter
 * imports and no application ships — and must never be re-exported from
 * `@agent-surface/core`, mirroring `AS-EXPLAIN-004` (`AS-COVER-006`).
 *
 * ## Failure discipline is the substance, not a detail
 *
 * > Better a missing check than a misleading check.
 *
 * A call site this module cannot understand is **reported with its file and
 * line**, never dropped. An inventory that silently omitted the constructs it
 * failed to parse would understate the denominator, and a coverage number built
 * on it would claim completeness it never had.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import ts from "typescript";

/** Identity could not be recovered from the call site at all. */
export const UNRESOLVED_ID = "<unresolved>";

export interface AuthoredCapability {
  /** Canonical id, instance-independent: `view:devices.table.sort`. */
  capabilityId: string;
  kind: "observation" | "action" | "procedure";
  /** Where a human can go and read it. */
  origin: { file: string; line: number; site: string };
  /** Literals recovered from the call site; absent when not statically known. */
  description?: string;
  effect?: string;
  /**
   * How much of this call site the extractor understood.
   *
   * `static` — identity and metadata both recovered from literals.
   * `partial` — identity resolved, some metadata or runtime presence dynamic.
   *   The common case: a spread `instanceId`, a conditional capability, or a
   *   description built from a template.
   * `unresolved` — identity NOT resolved. Reported, never dropped.
   */
  resolution: "static" | "partial" | "unresolved";
  /** Present on `partial`/`unresolved`: what defeated the extractor. */
  note?: string;
  /**
   * Present on `unresolved`: *which* construct defeated the extractor, as a
   * stable code rather than prose.
   *
   * `note` is written for a human and gets reworded — the spread note changed
   * in the same release that introduced it. Anything keyed on that prose would
   * silently invalidate itself on an edit no one thought was behavioural, which
   * is exactly what `unresolved-allow.json` must not do. This is the key.
   */
  reason?: UnreadReason;
}

/**
 * Why a registration could not be fully read. Stable identifiers: adding one is
 * fine, renaming one invalidates committed allowlists and is a breaking change.
 */
export type UnreadReason =
  | "dynamic-type"
  | "dynamic-config"
  | "dynamic-group"
  | "dynamic-callee"
  | "spread-members"
  | "computed-name"
  | "granular-hook";

export interface CapabilityInventory {
  capabilities: AuthoredCapability[];
  /** Absolute path to the tsconfig whose file list was analyzed. */
  tsconfig: string;
  /** Directory the analysis was rooted at — the surface config's own. */
  root: string;
  /** Files the program actually walked — the inventory's blast radius. */
  filesAnalyzed: number;
  /**
   * Agent-surface implementation files excluded outside `root`. First-party
   * workspace sources are analyzed; the implementation behind the authored
   * hooks is not a second app registration.
   */
  filesOutsideRoot: number;
  /**
   * The `domain:` plane is deliberately *not* analyzed here. Those capabilities
   * come from the oRPC router, which is already a static export (OQ-1), and
   * reporting zero of them would read as "there are none" rather than "nobody
   * looked".
   */
  domain: "not-analyzed";
}

/* ── locating the program ─────────────────────────────────────────────── */

export function findTsconfig(from: string): string | undefined {
  return ts.findConfigFile(resolve(from), ts.sys.fileExists, "tsconfig.json");
}

/** Reads a literal config `scope: ["..."]` without executing or mounting it. */
export function readLiteralConfigScope(configPath: string): string[] | undefined {
  const source = ts.createSourceFile(
    configPath,
    readFileSync(configPath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    configPath.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  let scope: string[] | undefined;
  const visit = (node: ts.Node): void => {
    if (scope) return;
    if (
      ts.isPropertyAssignment(node) &&
      propertyName(node.name) === "scope" &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      const values = node.initializer.elements.map((entry) => literalText(entry));
      if (values.every((value): value is string => value !== undefined)) scope = values;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return scope;
}

interface ProgramFiles {
  fileNames: string[];
  options: ts.CompilerOptions;
}

function readProgramFiles(tsconfigPath: string): ProgramFiles {
  const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (read.error) {
    throw new Error(
      `could not read ${tsconfigPath}: ${ts.flattenDiagnosticMessageText(read.error.messageText, " ")}`,
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    read.config as object,
    ts.sys,
    dirname(tsconfigPath),
  );
  if (parsed.errors.length > 0 && parsed.fileNames.length === 0) {
    throw new Error(
      `could not resolve any files from ${tsconfigPath}: ${parsed.errors
        .map((error) => ts.flattenDiagnosticMessageText(error.messageText, " "))
        .join("; ")}`,
    );
  }
  return { fileNames: parsed.fileNames, options: parsed.options };
}

/* ── which local name is a registration API ───────────────────────────── */

/**
 * The hooks a registration is written with, under the names *this library
 * exports them as* — not the names a codebase happens to call them by.
 *
 * `register` is deliberately absent. It is a method on a registry instance
 * rather than an import, so there is no binding to read; it stays matched by
 * name, with the extra `type` check `visitCall` already applies to it.
 */
const REGISTRATION_HOOKS = new Set(["useAgentComponent", "useAgentAction", "useAgentObservation"]);

/** `@agent-surface/react`, `@agent-surface/core`, and any subpath of either. */
function isRegistrationModule(specifier: string): boolean {
  return specifier.startsWith("@agent-surface/");
}

/**
 * What a file's own import declarations say about which local names are ours.
 *
 * A registration is identified by *what was imported*, not by what this file
 * calls it. Matching the local identifier alone lost a whole registration to a
 * rename:
 *
 * ```tsx
 * import { useAgentComponent as useAC } from "@agent-surface/react";
 * useAC({ type: "alias.panel", … });
 * ```
 *
 * — no capability in the catalog, and no unread call site saying the catalog
 * was short. Every other gap in this module *reports*: a dynamic `type`, an
 * unreadable spread, a granular hook, a wrapper it cannot prove. This one was
 * silent, and a silent gap is the only kind that makes a coverage number lie.
 */
interface ImportedApi {
  /** Local name → the registration hook it is bound to. */
  locals: Map<string, string>;
  /** Locals bound to a whole module of ours by `import * as ns`. */
  namespaces: Set<string>;
}

const NO_IMPORTS: ImportedApi = { locals: new Map(), namespaces: new Set() };

function importedRegistrations(source: ts.SourceFile): ImportedApi {
  const locals = new Map<string, string>();
  const namespaces = new Set<string>();

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!isRegistrationModule(statement.moduleSpecifier.text)) continue;

    // `import type { … }` binds no value, so it can call nothing. A default
    // import binds nothing of ours either: none of these packages has one.
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly || !clause.namedBindings) continue;

    if (ts.isNamespaceImport(clause.namedBindings)) {
      namespaces.add(clause.namedBindings.name.text);
      continue;
    }
    for (const element of clause.namedBindings.elements) {
      if (element.isTypeOnly) continue;
      const imported = (element.propertyName ?? element.name).text;
      if (REGISTRATION_HOOKS.has(imported)) locals.set(element.name.text, imported);
    }
  }
  return { locals, namespaces };
}

/**
 * Registration hooks this file re-exports under a name that is not their own.
 *
 * ```ts
 * export { useAgentComponent as useAC } from "@agent-surface/react";
 * ```
 *
 * Downstream every call site is spelled `useAC` and imported from a module that
 * is not ours, so nothing there proves it registers anything — and following
 * the chain to find out is the hop `callsWrapper` already refuses to take, for
 * the same reason: a wrong attribution fabricates catalog entries.
 *
 * So the gap is reported *here*, on the line that opens it, rather than left
 * unsaid at each of the call sites it hides. Re-exported under its own name it
 * needs no report at all — downstream then reads a name this module knows.
 */
function renamedRegistrationExports(
  source: ts.SourceFile,
  imports: ImportedApi,
): { node: ts.Node; hook: string; exported: string }[] {
  const renamed: { node: ts.Node; hook: string; exported: string }[] = [];

  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue;
    const clause = statement.exportClause;
    if (!clause || !ts.isNamedExports(clause)) continue;

    const from = statement.moduleSpecifier;
    // `export … from` some other module says nothing about our API; the local
    // form is read against what this file imported.
    const fromOurs =
      from !== undefined && ts.isStringLiteral(from) && isRegistrationModule(from.text);
    if (from && !fromOurs) continue;

    for (const element of clause.elements) {
      if (element.isTypeOnly) continue;
      const local = (element.propertyName ?? element.name).text;
      const hook = fromOurs
        ? REGISTRATION_HOOKS.has(local)
          ? local
          : undefined
        : imports.locals.get(local);
      // Renaming *back* to the hook's own name closes the gap rather than
      // opening one, so the comparison is against the export, not the local.
      if (hook === undefined || element.name.text === hook) continue;
      renamed.push({ node: element, hook, exported: element.name.text });
    }
  }
  return renamed;
}

/* ── small AST helpers ────────────────────────────────────────────────── */

/** Whether `object.member` reads a registration hook off a namespace of ours. */
function namespaceMember(object: ts.Expression, member: string, imports: ImportedApi): boolean {
  return (
    ts.isIdentifier(object) && imports.namespaces.has(object.text) && REGISTRATION_HOOKS.has(member)
  );
}

function calleeName(call: ts.CallExpression, imports: ImportedApi = NO_IMPORTS): string | undefined {
  const callee = call.expression;

  // An alias is the same API under another name, and the binding says which.
  if (ts.isIdentifier(callee)) return imports.locals.get(callee.text) ?? callee.text;

  if (ts.isPropertyAccessExpression(callee)) {
    // `AS.useAgentComponent()`: the namespace binding is what *proves* this one
    // is ours. It resolved before this existed, but only because the property
    // name happened to be spelled like the hook — a coincidence that would have
    // attributed `anything.useAgentComponent()` just as readily.
    if (namespaceMember(callee.expression, callee.name.text, imports)) return callee.name.text;
    // Otherwise the plain name, which is what reads `registry.register(…)`.
    // Narrowing this to proven bindings would *drop* registrations that resolve
    // today — a re-export under its own name, most of all — and a silent loss
    // is the failure this whole change exists to remove.
    return callee.name.text;
  }

  // `AS["useAgentComponent"]()` is as readable as the dotted form.
  if (ts.isElementAccessExpression(callee)) {
    const member = literalText(callee.argumentExpression);
    if (member !== undefined && namespaceMember(callee.expression, member, imports)) return member;
  }
  return undefined;
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

function propertyOf(
  object: ts.ObjectLiteralExpression,
  wanted: string,
): ts.Expression | undefined {
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && propertyName(property.name) === wanted) {
      return property.initializer;
    }
    // `{ type }` is `{ type: type }`, and the shorthand is what a wrapper hook
    // forwarding a parameter actually writes. Reading only the long form made
    // every such config look like it had no `type` at all.
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === wanted) {
      return property.name;
    }
  }
  return undefined;
}

function hasSpread(object: ts.ObjectLiteralExpression): boolean {
  return object.properties.some((property) => ts.isSpreadAssignment(property));
}

/** The capability groups a spread would have to contribute to matter here. */
const CAPABILITY_GROUPS = ["observations", "actions"] as const;

/**
 * Every key a spread could contribute, or `undefined` when that is not knowable.
 *
 * This exists to separate two spreads that look alike and are not:
 *
 * ```tsx
 * ...(props.instance ? { instanceId: props.instance } : {})   // keys: instanceId
 * ...buildMembers()                                            // keys: unknown
 * ```
 *
 * The first cannot contribute a capability, because its key set is written out
 * and `instanceId` is not part of a capability id. The second could contribute
 * any number of them. Reporting both would flood the documented common case;
 * reporting neither is what let a whole registration disappear.
 *
 * Resolution is deliberately shallow, matching `objectLiteralFor`'s one hop: a
 * literal, a conditional over two knowable branches, or a same-module `const`.
 * Anything else is unknown, and unknown is reported rather than assumed empty.
 */
function spreadKeys(
  expression: ts.Expression,
  source: ts.SourceFile,
  depth = 0,
): string[] | undefined {
  if (depth > 1) return undefined;

  if (ts.isParenthesizedExpression(expression)) {
    return spreadKeys(expression.expression, source, depth);
  }

  // `cond ? { a } : {}` contributes whichever branch runs, so the key set is
  // the union — knowable only if both branches are.
  if (ts.isConditionalExpression(expression)) {
    const whenTrue = spreadKeys(expression.whenTrue, source, depth);
    const whenFalse = spreadKeys(expression.whenFalse, source, depth);
    if (!whenTrue || !whenFalse) return undefined;
    return [...new Set([...whenTrue, ...whenFalse])];
  }

  const resolved = objectLiteralFor(expression, source);
  if (!resolved.object) return undefined;

  const keys: string[] = [];
  for (const property of resolved.object.properties) {
    // A spread inside a spread: recurse while the hop budget allows, then admit
    // defeat rather than reporting a partial key set as a complete one.
    if (ts.isSpreadAssignment(property)) {
      const nested = spreadKeys(property.expression, source, depth + 1);
      if (!nested) return undefined;
      keys.push(...nested);
      continue;
    }
    const name =
      ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)
        ? propertyName(property.name)
        : ts.isShorthandPropertyAssignment(property)
          ? property.name.text
          : undefined;
    // A computed key could be anything, including a capability group.
    if (name === undefined) return undefined;
    keys.push(name);
  }
  return [...new Set(keys)];
}

function literalText(node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return literalText(node.expression);
  // `"one long " + "description split over two lines"` is as statically known
  // as either half. Descriptions are the provider's cached prompt prefix (D28),
  // so they are long enough that authors wrap them — calling that `partial`
  // would report the codebase's most common formatting choice as a defect.
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = literalText(node.left);
    const right = literalText(node.right);
    if (left !== undefined && right !== undefined) return left + right;
  }
  return undefined;
}

/** A short name for whatever construct defeated us, for the `note`. */
function describeConstruct(node: ts.Expression): string {
  if (ts.isCallExpression(node)) {
    const callee = calleeName(node);
    return callee ? `built by ${callee}()` : "built by a call expression";
  }
  if (ts.isIdentifier(node)) return `a variable (${node.text}) this extractor could not follow`;
  if (ts.isConditionalExpression(node)) return "a conditional expression";
  if (ts.isTemplateExpression(node)) return "a template with substitutions";
  if (ts.isPropertyAccessExpression(node)) return "a property access";
  return "a non-literal expression";
}

/**
 * Resolves a config argument to an object literal, following **one hop** to a
 * same-module `const`.
 *
 * One hop is the whole rule. `useAgentComponent(CONFIG)` where `CONFIG` is a
 * module constant is common and cheap; `useAgentComponent(buildConfig(props))`
 * is not resolvable at any depth worth implementing. Stopping at one hop keeps
 * the limit *visible in the output* rather than buried in the implementation —
 * the deeper case is reported as `unresolved` with the construct named, which
 * is the behaviour this module exists to guarantee.
 */
function objectLiteralFor(
  expression: ts.Expression,
  source: ts.SourceFile,
): { object?: ts.ObjectLiteralExpression; note?: string } {
  if (ts.isObjectLiteralExpression(expression)) return { object: expression };

  if (ts.isIdentifier(expression)) {
    const target = expression.text;
    let found: ts.ObjectLiteralExpression | undefined;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === target &&
        node.initializer &&
        ts.isObjectLiteralExpression(node.initializer)
      ) {
        found = node.initializer;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (found) return { object: found };
    return {
      note: `the config is \`${target}\`, which is not a same-module object literal — the extractor follows one hop only`,
    };
  }

  return { note: `the config is ${describeConstruct(expression)}` };
}

/* ── the extraction itself ────────────────────────────────────────────── */

/** Hooks that register one capability against the enclosing render scope. */
const GRANULAR_HOOKS = new Set(["useAgentAction", "useAgentObservation"]);

interface Emitter {
  push(capability: AuthoredCapability): void;
  origin(node: ts.Node): { file: string; line: number; site: string };
}

function capabilitiesFromGroup(
  group: ts.Expression | undefined,
  kind: "observation" | "action",
  componentType: string,
  componentPartial: string | undefined,
  emit: Emitter,
  source: ts.SourceFile,
): void {
  if (!group) return;

  const resolved = objectLiteralFor(group, source);
  if (!resolved.object) {
    emit.push({
      capabilityId: `view:${componentType}.${UNRESOLVED_ID}`,
      kind,
      origin: emit.origin(group),
      resolution: "unresolved",
      reason: "dynamic-group",
      note: `\`${kind}s\` on "${componentType}" is not an object literal: ${resolved.note}`,
    });
    return;
  }

  for (const property of resolved.object.properties) {
    // A capability-map spread is only an identity gap when its keys cannot be
    // read. Readable keys are authored capabilities even when runtime presence
    // is conditional; the catalog is deliberately an upper bound.
    if (ts.isSpreadAssignment(property)) {
      const keys = spreadKeys(property.expression, source);
      if (keys === undefined) {
        emit.push({
          capabilityId: `view:${componentType}.${UNRESOLVED_ID}`,
          kind,
          origin: emit.origin(property),
          resolution: "unresolved",
          reason: "spread-members",
          note: `\`${kind}s\` on "${componentType}" spreads another object, which may contribute capabilities this inventory cannot name`,
        });
        continue;
      }

      for (const name of keys) {
        const notes = [
          ...(componentPartial ? [componentPartial] : []),
          `\`${name}\` is contributed by a spread, so its definition metadata or runtime presence may be dynamic`,
        ];
        emit.push({
          capabilityId: `view:${componentType}.${name}`,
          kind,
          origin: emit.origin(property),
          resolution: "partial",
          note: notes.join("; "),
        });
      }
      continue;
    }

    const name =
      ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)
        ? propertyName(property.name)
        : ts.isShorthandPropertyAssignment(property)
          ? property.name.text
          : undefined;

    if (name === undefined) {
      emit.push({
        capabilityId: `view:${componentType}.${UNRESOLVED_ID}`,
        kind,
        origin: emit.origin(property),
        resolution: "unresolved",
        reason: "computed-name",
        note: `a capability on "${componentType}" has a computed name`,
      });
      continue;
    }

    // Identity is recovered from the key alone; the value only carries metadata.
    const capability: AuthoredCapability = {
      capabilityId: `view:${componentType}.${name}`,
      kind,
      origin: emit.origin(property),
      resolution: "static",
    };
    const notes: string[] = [];
    if (componentPartial) notes.push(componentPartial);

    const value = ts.isPropertyAssignment(property) ? property.initializer : undefined;
    const definition =
      value && ts.isCallExpression(value) && value.arguments.length > 0
        ? value.arguments[0]
        : value;

    if (definition && ts.isObjectLiteralExpression(definition)) {
      const description = literalText(propertyOf(definition, "description"));
      if (description !== undefined) capability.description = description;
      else notes.push("description is not a string literal");

      if (kind === "action") {
        const effect = literalText(propertyOf(definition, "effect"));
        if (effect !== undefined) capability.effect = effect;
        else notes.push("effect is not a string literal");
      }
      if (hasSpread(definition)) notes.push("the definition spreads another object");
    } else {
      notes.push(
        value
          ? `the definition is ${describeConstruct(value)}`
          : "the definition is not an object literal",
      );
    }

    if (notes.length > 0) {
      capability.resolution = "partial";
      capability.note = notes.join("; ");
    }
    emit.push(capability);
  }
}

function visitCall(
  call: ts.CallExpression,
  emit: Emitter,
  source: ts.SourceFile,
  imports: ImportedApi,
  deferred: DeferredWrapper[],
  enclosing: EnclosingFunction | undefined,
): void {
  const callee = calleeName(call, imports);
  if (callee === undefined) {
    // The callee is not a name at all. Where it reads a computed member of a
    // namespace of ours, that much *is* known: a call into the registration API
    // whose export cannot be named, and so whose registration — if it is one —
    // is nowhere in this catalog. Anywhere else it is simply not our call.
    const object = ts.isElementAccessExpression(call.expression)
      ? call.expression.expression
      : undefined;
    if (object && ts.isIdentifier(object) && imports.namespaces.has(object.text)) {
      emit.push({
        capabilityId: UNRESOLVED_ID,
        kind: "action",
        origin: emit.origin(call),
        resolution: "unresolved",
        reason: "dynamic-callee",
        note: `a call reads a computed member of \`${object.text}\`, a namespace of this library — which export it calls, and so whether it registers anything, cannot be read here`,
      });
    }
    return;
  }

  if (GRANULAR_HOOKS.has(callee)) {
    // OQ-3: the granular hooks register through a render-scope link rather than
    // one aggregated descriptor, so the component `type` is not at this call
    // site at all. Reporting the call site as unresolved is the honest state
    // until that join key is settled — silently ignoring it would make a
    // codebase that uses them look fully covered.
    emit.push({
      capabilityId: UNRESOLVED_ID,
      kind: callee === "useAgentAction" ? "action" : "observation",
      origin: emit.origin(call),
      resolution: "unresolved",
      reason: "granular-hook",
      note: `${callee}() registers against a render-scope link, so its component type is not at this call site`,
    });
    return;
  }

  if (callee !== "useAgentComponent" && callee !== "register") return;
  const argument = call.arguments[0];
  if (!argument) return;

  const resolved = objectLiteralFor(argument, source);
  if (!resolved.object) {
    emit.push({
      capabilityId: UNRESOLVED_ID,
      kind: "action",
      origin: emit.origin(call),
      resolution: "unresolved",
      reason: "dynamic-config",
      note: `${callee}() call site could not be read: ${resolved.note}`,
    });
    return;
  }

  const config = resolved.object;
  const typeNode = propertyOf(config, "type");
  const type = literalText(typeNode);
  if (type === undefined) {
    // `register` is a common method name; only treat it as ours once the call
    // actually looks like a registration. A `type` that exists but is dynamic
    // *is* ours, and is a genuine finding.
    if (callee === "register" && typeNode === undefined) return;

    // A `type` that is a parameter of the enclosing function is not dynamic —
    // it is decided one frame up, at the wrapper's call sites, and those are
    // string literals often enough to be worth following (OQ-13). Defer it;
    // the second pass either resolves it or reports it unread as before.
    const slot =
      enclosing && typeNode && ts.isIdentifier(typeNode)
        ? parameterSlot(typeNode.text, enclosing.fn)
        : undefined;
    if (slot && enclosing?.name) {
      deferred.push({ config, source, emit, wrapperName: enclosing.name, slot, site: call });
      return;
    }

    emit.push({
      capabilityId: UNRESOLVED_ID,
      kind: "action",
      origin: emit.origin(call),
      resolution: "unresolved",
      reason: "dynamic-type",
      note: `\`type\` is not a string literal, so no capability id on this component can be determined`,
    });
    return;
  }

  // A spread at the component level is the documented common case — the
  // conditional `...(props.instance ? { instanceId } : {})`. `instanceId` is not
  // part of a capability id, so identity survives; metadata may not.
  const componentPartial = hasSpread(config)
    ? "the component config spreads another object, so some metadata here may be dynamic"
    : undefined;

  // A spread whose key set cannot be read may carry `observations` or `actions`,
  // and those capabilities are then nowhere in this program's reach. Left
  // unreported, the registration disappears from *both* lists: absent from the
  // catalog, and absent from the unread call sites that exist to say the catalog
  // is incomplete. The count then claims a completeness it does not have, which
  // is the one failure this whole module is built to prevent.
  //
  // Enumerating the literal groups below is not enough on its own, either: a
  // config with a literal `observations` *and* an unreadable spread is missing
  // whatever `actions` the spread contributes, and the half that resolved would
  // otherwise read as the whole.
  for (const property of config.properties) {
    if (!ts.isSpreadAssignment(property)) continue;
    const keys = spreadKeys(property.expression, source);
    if (keys && !keys.some((key) => CAPABILITY_GROUPS.includes(key as "observations" | "actions"))) {
      continue;
    }
    emit.push({
      capabilityId: `view:${type}.${UNRESOLVED_ID}`,
      kind: "action",
      origin: emit.origin(property),
      resolution: "unresolved",
      reason: "spread-members",
      note: keys
        ? `"${type}" spreads ${describeConstruct(property.expression)}, which contributes \`${keys
            .filter((key) => CAPABILITY_GROUPS.includes(key as "observations" | "actions"))
            .join("`/`")}\` this inventory cannot name`
        : `"${type}" spreads ${describeConstruct(property.expression)}, whose keys this inventory cannot read — it may contribute capabilities not listed here`,
    });
  }

  capabilitiesFromGroup(
    propertyOf(config, "observations"),
    "observation",
    type,
    componentPartial,
    emit,
    source,
  );
  capabilitiesFromGroup(
    propertyOf(config, "actions"),
    "action",
    type,
    componentPartial,
    emit,
    source,
  );
}

/* ── wrapper hooks: one hop *up* the call graph (OQ-13) ───────────────── */

/**
 * A registration whose `type` is a parameter of the enclosing function.
 *
 * ```tsx
 * function useRegisteredPanel(type: string) {
 *   useAgentComponent({ type, observations: { … } });   // ← here
 * }
 * useRegisteredPanel("devices.table");                  // ← type lives here
 * ```
 *
 * The capability ids are still fully determined by source text; they are just
 * determined *one frame up*. Reported unread, a single such wrapper hides the
 * whole surface built on it — 91% of one real application's capabilities
 * ([#31](https://github.com/Wiseair-srl/agent-surface/issues/31)).
 *
 * Resolution is deferred to a second pass because a call site may live in a
 * file walked before the wrapper's own.
 */
interface DeferredWrapper {
  config: ts.ObjectLiteralExpression;
  source: ts.SourceFile;
  emit: Emitter;
  /** The name a call site would use. */
  wrapperName: string;
  /** Where `type` sits in the wrapper's signature. */
  slot: { index: number; property?: string };
  /** The node to blame when this cannot be resolved. */
  site: ts.Node;
}

interface CallSite {
  call: ts.CallExpression;
  source: ts.SourceFile;
}

/**
 * The function a call sits inside, and the name a caller would use for it.
 *
 * Tracked on the way *down* the tree rather than read from `node.parent`:
 * `ts.createProgram` leaves parent pointers unset until something forces the
 * binder to run, and forcing it means constructing a type checker — real work
 * on a large program, for an answer the walk already has in hand.
 */
interface EnclosingFunction {
  fn: ts.SignatureDeclaration;
  /** `function useX()` and `const useX = () => {}` both name the wrapper. */
  name?: string;
}

function functionLike(node: ts.Node): ts.SignatureDeclaration | undefined {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  ) {
    return node;
  }
  return undefined;
}

/**
 * Where a `type` identifier comes from in the enclosing signature, if it is a
 * parameter at all. Both spellings authors actually use:
 *
 * ```ts
 * function useX(type: string)          // { index: 0 }
 * function useX({ type }: Props)       // { index: 0, property: "type" }
 * ```
 */
function parameterSlot(
  name: string,
  fn: ts.SignatureDeclaration,
): { index: number; property?: string } | undefined {
  for (const [index, parameter] of fn.parameters.entries()) {
    if (ts.isIdentifier(parameter.name)) {
      if (parameter.name.text === name) return { index };
      continue;
    }
    if (ts.isObjectBindingPattern(parameter.name)) {
      for (const element of parameter.name.elements) {
        if (!ts.isIdentifier(element.name) || element.name.text !== name) continue;
        // `{ type: kind }` binds `kind` locally but reads the `type` property.
        const property =
          element.propertyName && ts.isIdentifier(element.propertyName)
            ? element.propertyName.text
            : name;
        return { index, property };
      }
    }
  }
  return undefined;
}

/**
 * Whether `site` is provably a call of `wrapper`, and not of something else
 * that happens to share its name.
 *
 * This predicate is the whole safety argument. Attributing a wrapper's
 * capabilities to the wrong call site would put ids in the catalog that no
 * component authors — **fabricating** entries, a failure this package has never
 * had and must not acquire. Reporting unread is always the safe answer, so
 * anything short of certainty returns `false`:
 *
 * - declared in the same file — lexically certain;
 * - imported, and the specifier resolves to the wrapper's own file;
 * - anything else — a re-export chain, a namespace import, a dynamic import —
 *   is not certain, and is left unread.
 */
function callsWrapper(
  site: CallSite,
  wrapper: DeferredWrapper,
  compilerOptions: ts.CompilerOptions,
): boolean {
  const callee = site.call.expression;
  if (!ts.isIdentifier(callee) || callee.text !== wrapper.wrapperName) return false;

  if (site.source.fileName === wrapper.source.fileName) {
    // Same file: the only way this is a different function is a local shadow,
    // which would also shadow it for the reader.
    return true;
  }

  for (const statement of site.source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    if (!clause) continue;

    const named =
      clause.name?.text === wrapper.wrapperName ||
      (clause.namedBindings &&
        ts.isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.some((element) => element.name.text === wrapper.wrapperName));
    if (!named) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;

    const resolved = ts.resolveModuleName(
      statement.moduleSpecifier.text,
      site.source.fileName,
      compilerOptions,
      ts.sys,
    ).resolvedModule;
    if (resolved?.resolvedFileName === wrapper.source.fileName) return true;
  }
  return false;
}

export interface ExtractOptions {
  /** Directory the analysis is rooted at — normally the surface config's dir. */
  root: string;
  /** Explicit tsconfig; found upward from `root` when omitted. */
  tsconfig?: string;
}

/** Whitespace-insensitive source text, so a reformat is not a different site. */
function normalizedText(node: ts.Node, source: ts.SourceFile): string {
  return node.getText(source).replace(/\s+/g, " ").trim();
}

interface SiteIdentity {
  /** Named enclosures, outermost first. */
  labels: string[];
  enclosingCall: string;
  /** Innermost named enclosure, or the file — the subtree a twin could be in. */
  scope: ts.Node;
}

function siteIdentity(source: ts.SourceFile, node: ts.Node): SiteIdentity {
  const labels: string[] = [];
  let enclosingCall = "";
  let scope: ts.Node | undefined;

  for (let parent = node.parent; parent && parent !== source; parent = parent.parent) {
    if (!enclosingCall && ts.isCallExpression(parent)) {
      enclosingCall = normalizedText(parent, source);
    }
    const named =
      (ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent)) &&
      parent.name &&
      (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name))
        ? parent.name.text
        : ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)
          ? parent.name.text
          : undefined;
    if (named !== undefined) {
      labels.push(named);
      scope ??= parent;
    }
  }
  return { labels: labels.reverse(), enclosingCall, scope: scope ?? source };
}

/**
 * How many identical nodes precede this one inside its named enclosure.
 *
 * Read from source *positions*, never from the order this module visits them:
 * the deferred wrapper pass emits origins for one file while walking another,
 * so a running counter would hand out a different answer depending on which ran
 * first — and a fingerprint that depends on traversal order is not one.
 */
function occurrence(scope: ts.Node, node: ts.Node, source: ts.SourceFile): number {
  const text = normalizedText(node, source);
  const start = node.getStart(source);
  let rank = 0;
  const visit = (candidate: ts.Node): void => {
    if (
      candidate.kind === node.kind &&
      candidate.getStart(source) < start &&
      normalizedText(candidate, source) === text
    ) {
      rank += 1;
    }
    ts.forEachChild(candidate, visit);
  };
  ts.forEachChild(scope, visit);
  return rank;
}

/**
 * Which site this is, as something a committed allowance can be keyed on.
 *
 * Identity is the node's own text and the named enclosures around it. Nothing
 * positional goes in: not the line, and — the bug this replaces — not the
 * surrounding source either. An earlier version hashed a window of neighbouring
 * lines to tell two otherwise identical sites apart. It did tell them apart,
 * and it also moved the fingerprint whenever a comment changed within ten
 * lines, silently invalidating the entry and failing `check` for an edit nobody
 * thought was behavioural. That is the exact churn this key exists to survive,
 * and `file#reason` survived it before.
 *
 * Genuine twins — byte-identical calls in the same named enclosure — are told
 * apart by their rank within it instead. Inserting a third after them leaves
 * both keys alone; only a twin inserted *before* one shifts it, which is a
 * change to the very thing the key names.
 */
function stableSite(source: ts.SourceFile, node: ts.Node): string {
  const { labels, enclosingCall, scope } = siteIdentity(source, node);
  return createHash("sha256")
    .update(
      `${labels.join("/")}\0${enclosingCall}\0${normalizedText(node, source)}\0${occurrence(
        scope,
        node,
        source,
      )}`,
    )
    .digest("hex")
    .slice(0, 12);
}

const packageNameCache = new Map<string, string | undefined>();

function packageNameFor(file: string): string | undefined {
  let dir = dirname(file);
  for (;;) {
    if (packageNameCache.has(dir)) return packageNameCache.get(dir);
    const packagePath = join(dir, "package.json");
    if (existsSync(packagePath)) {
      let name: string | undefined;
      try {
        const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as { name?: unknown };
        if (typeof parsed.name === "string") name = parsed.name;
      } catch {
        // A malformed package boundary cannot make a file trusted/excluded.
      }
      packageNameCache.set(dir, name);
      return name;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const IMPLEMENTATION_PACKAGES = new Set([
  "@agent-surface/core",
  "@agent-surface/react",
  "@agent-surface/orpc",
  "@agent-surface/testing",
  "@agent-surface/webmcp",
  "@agent-surface/cli",
]);

function isAgentSurfaceImplementation(file: string): boolean {
  return IMPLEMENTATION_PACKAGES.has(packageNameFor(file) ?? "");
}

/**
 * Reads the program and returns every capability its registration call sites
 * author. Nothing is executed: no Vite server, no jsdom, no scenarios, no mount.
 */
export function extractCapabilities(options: ExtractOptions): CapabilityInventory {
  const root = resolve(options.root);
  const tsconfigPath = options.tsconfig
    ? isAbsolute(options.tsconfig)
      ? options.tsconfig
      : join(root, options.tsconfig)
    : findTsconfig(root);

  if (!tsconfigPath || !existsSync(tsconfigPath)) {
    throw new Error(
      `no tsconfig.json found from ${root} — \`capabilities\` reads the TypeScript program, ` +
        "so it needs one (pass --tsconfig to point at it)",
    );
  }

  const { fileNames, options: compilerOptions } = readProgramFiles(tsconfigPath);
  const program = ts.createProgram(fileNames, compilerOptions);

  const capabilities: AuthoredCapability[] = [];
  let filesAnalyzed = 0;

  let filesOutsideRoot = 0;

  // Registrations whose `type` comes from a parameter, and every call that
  // could supply it. Both are filled during the single walk below; the join
  // happens after, because a call site may live in a file walked earlier.
  const deferred: DeferredWrapper[] = [];
  const callsByName = new Map<string, CallSite[]>();

  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile) continue;
    if (source.fileName.includes("/node_modules/")) continue;
    // Workspace sources are part of the authored denominator even when they
    // live beside the config package. Only agent-surface's own implementation
    // packages are excluded: their `registry.register(definition)` is the hook
    // implementation, not another authored registration.
    if (!isInside(root, source.fileName) && isAgentSurfaceImplementation(source.fileName)) {
      filesOutsideRoot += 1;
      continue;
    }
    filesAnalyzed += 1;

    const emit: Emitter = {
      push: (capability) => capabilities.push(capability),
      origin: (node) => ({
        file: relative(root, source.fileName),
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        site: stableSite(source, node),
      }),
    };

    // Read once per file: every call site in it is identified against these.
    const imports = importedRegistrations(source);
    for (const renamed of renamedRegistrationExports(source, imports)) {
      emit.push({
        capabilityId: UNRESOLVED_ID,
        kind: "action",
        origin: emit.origin(renamed.node),
        resolution: "unresolved",
        reason: "dynamic-callee",
        note: `${renamed.hook}() leaves this module as \`${renamed.exported}\`, so nothing at its call sites elsewhere proves they register anything — whatever they author is not in this catalog`,
      });
    }

    let pendingName: string | undefined;
    const visit = (node: ts.Node, enclosing?: EnclosingFunction): void => {
      const fn = functionLike(node);
      if (fn) {
        // A variable declaration names the arrow it initialises, and the walk
        // sees the declaration first — so the name is already in hand here.
        const named = ts.isFunctionDeclaration(node) && node.name ? node.name.text : pendingName;
        enclosing = { fn, ...(named ? { name: named } : {}) };
        pendingName = undefined;
      } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        pendingName = node.name.text;
      }

      if (ts.isCallExpression(node)) {
        visitCall(node, emit, source, imports, deferred, enclosing);
        // Every identifier-callee call is a potential wrapper call site. Indexed
        // by name here so the second pass does not re-walk the program.
        if (ts.isIdentifier(node.expression)) {
          const name = node.expression.text;
          const sites = callsByName.get(name) ?? [];
          sites.push({ call: node, source });
          callsByName.set(name, sites);
        }
      }
      ts.forEachChild(node, (child) => visit(child, enclosing));
    };
    visit(source);
  }

  // Second pass: one hop *up* the call graph. The first pass follows one hop
  // sideways to a same-module `const`; this is the same budget pointed the
  // other way, and it is what turns a shared wrapper hook from a single unread
  // line into the capabilities it actually authors.
  for (const wrapper of deferred) {
    const sites = (callsByName.get(wrapper.wrapperName) ?? []).filter((site) =>
      callsWrapper(site, wrapper, compilerOptions),
    );

    const types = new Map<string, ts.CallExpression>();
    const dynamic: CallSite[] = [];
    for (const site of sites) {
      const argument = site.call.arguments[wrapper.slot.index];
      const value =
        wrapper.slot.property && argument && ts.isObjectLiteralExpression(argument)
          ? propertyOf(argument, wrapper.slot.property)
          : argument;
      const text = value ? literalText(value) : undefined;
      if (text !== undefined) types.set(text, site.call);
      else dynamic.push(site);
    }

    // Partial resolution beats all-or-nothing: 15 literals plus 2 unread lines
    // is a truer catalog than 17 unread lines, and it stays honest about which
    // two it could not read.
    for (const type of [...types.keys()].sort()) {
      const componentPartial = hasSpread(wrapper.config)
        ? "the component config spreads another object, so some metadata here may be dynamic"
        : undefined;
      for (const [group, kind] of [
        ["observations", "observation"],
        ["actions", "action"],
      ] as const) {
        capabilitiesFromGroup(
          propertyOf(wrapper.config, group),
          kind,
          type,
          componentPartial,
          wrapper.emit,
          wrapper.source,
        );
      }
    }

    if (types.size === 0 || dynamic.length > 0) {
      // Nothing resolved, or some call sites pass a non-literal. Either way the
      // catalog is a floor here and has to say so.
      wrapper.emit.push({
        capabilityId: UNRESOLVED_ID,
        kind: "action",
        origin: wrapper.emit.origin(wrapper.site),
        resolution: "unresolved",
        reason: "dynamic-type",
        note:
          types.size === 0
            ? `\`type\` is a parameter of ${wrapper.wrapperName}(), and no call site of it in this program passes a string literal`
            : `\`type\` is a parameter of ${wrapper.wrapperName}(); ${types.size} call site${
                types.size === 1 ? "" : "s"
              } resolved, ${dynamic.length} pass${dynamic.length === 1 ? "es" : ""} a non-literal`,
      });
    }
  }

  capabilities.sort(
    (a, b) =>
      a.capabilityId.localeCompare(b.capabilityId) ||
      a.origin.file.localeCompare(b.origin.file) ||
      a.origin.line - b.origin.line,
  );

  return {
    capabilities,
    tsconfig: tsconfigPath,
    root,
    filesAnalyzed,
    filesOutsideRoot,
    domain: "not-analyzed",
  };
}

/** True when `file` lives under `root` — the analyzed boundary. */
function isInside(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Distinct capability ids the inventory resolved — the coverage denominator. */
export function authoredIds(inventory: CapabilityInventory): Set<string> {
  const ids = new Set<string>();
  for (const capability of inventory.capabilities) {
    if (capability.resolution === "unresolved") continue;
    if (capability.capabilityId.endsWith(UNRESOLVED_ID)) continue;
    ids.add(capability.capabilityId);
  }
  return ids;
}

export function unresolved(inventory: CapabilityInventory): AuthoredCapability[] {
  return inventory.capabilities.filter((capability) => capability.resolution === "unresolved");
}
