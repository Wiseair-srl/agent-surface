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
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import ts from "typescript";

/** Identity could not be recovered from the call site at all. */
export const UNRESOLVED_ID = "<unresolved>";

export interface AuthoredCapability {
  /** Canonical id, instance-independent: `view:devices.table.sort`. */
  capabilityId: string;
  kind: "observation" | "action" | "procedure";
  /** Where a human can go and read it. */
  origin: { file: string; line: number };
  /** Literals recovered from the call site; absent when not statically known. */
  description?: string;
  effect?: string;
  /**
   * How much of this call site the extractor understood.
   *
   * `static` — identity and metadata both recovered from literals.
   * `partial` — identity resolved, some metadata dynamic. The common case: a
   *   spread `instanceId`, or a description built from a template.
   * `unresolved` — identity NOT resolved. Reported, never dropped.
   */
  resolution: "static" | "partial" | "unresolved";
  /** Present on `partial`/`unresolved`: what defeated the extractor. */
  note?: string;
}

export interface CapabilityInventory {
  capabilities: AuthoredCapability[];
  /** Absolute path to the tsconfig whose file list was analyzed. */
  tsconfig: string;
  /** Directory the analysis was rooted at — the surface config's own. */
  root: string;
  /** Files the program actually walked — the inventory's blast radius. */
  filesAnalyzed: number;
  /**
   * Program files skipped for living outside `root` — workspace packages the
   * app's tsconfig aliases in, typically the library's own source. Reported
   * rather than dropped silently: a boundary nobody can see is a boundary
   * nobody can check.
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

/* ── small AST helpers ────────────────────────────────────────────────── */

function calleeName(call: ts.CallExpression): string | undefined {
  if (ts.isIdentifier(call.expression)) return call.expression.text;
  if (ts.isPropertyAccessExpression(call.expression)) return call.expression.name.text;
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
  }
  return undefined;
}

function hasSpread(object: ts.ObjectLiteralExpression): boolean {
  return object.properties.some((property) => ts.isSpreadAssignment(property));
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
  origin(node: ts.Node): { file: string; line: number };
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
      note: `\`${kind}s\` on "${componentType}" is not an object literal: ${resolved.note}`,
    });
    return;
  }

  for (const property of resolved.object.properties) {
    // A spread inside the capability map can add capabilities this extractor
    // cannot name. That is an identity gap, not a metadata gap.
    if (ts.isSpreadAssignment(property)) {
      emit.push({
        capabilityId: `view:${componentType}.${UNRESOLVED_ID}`,
        kind,
        origin: emit.origin(property),
        resolution: "unresolved",
        note: `\`${kind}s\` on "${componentType}" spreads another object, which may contribute capabilities this inventory cannot name`,
      });
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

function visitCall(call: ts.CallExpression, emit: Emitter, source: ts.SourceFile): void {
  const callee = calleeName(call);
  if (callee === undefined) return;

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
      note: `${callee}() call site could not be read: ${resolved.note}`,
    });
    return;
  }

  const config = resolved.object;
  const type = literalText(propertyOf(config, "type"));
  if (type === undefined) {
    // `register` is a common method name; only treat it as ours once the call
    // actually looks like a registration. A `type` that exists but is dynamic
    // *is* ours, and is a genuine finding.
    if (callee === "register" && propertyOf(config, "type") === undefined) return;
    emit.push({
      capabilityId: UNRESOLVED_ID,
      kind: "action",
      origin: emit.origin(call),
      resolution: "unresolved",
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

export interface ExtractOptions {
  /** Directory the analysis is rooted at — normally the surface config's dir. */
  root: string;
  /** Explicit tsconfig; found upward from `root` when omitted. */
  tsconfig?: string;
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

  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile) continue;
    if (source.fileName.includes("/node_modules/")) continue;
    // A tsconfig with workspace path aliases pulls the library's *own* source
    // into the program, where `registry.register(definition)` inside
    // `useAgentComponent` reads as an unresolvable registration call site. It
    // is not one: it is the implementation every real call site goes through.
    // The inventory covers the app the surface config points at, and says so
    // rather than quietly widening or narrowing.
    if (!isInside(root, source.fileName)) {
      filesOutsideRoot += 1;
      continue;
    }
    filesAnalyzed += 1;

    const emit: Emitter = {
      push: (capability) => capabilities.push(capability),
      origin: (node) => ({
        file: relative(root, source.fileName),
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      }),
    };

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) visitCall(node, emit, source);
      ts.forEachChild(node, visit);
    };
    visit(source);
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
