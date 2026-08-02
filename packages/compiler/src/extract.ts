import { posix, relative, resolve } from "node:path";
import ts from "typescript";
import type {
  CapabilityContractEntry,
  CapabilityPolicyAttachment,
  CompiledCapabilityToken,
  CompiledComponentProvenance,
  JsonSchema,
} from "@agent-surface/core";
import { canonicalJson, sha256 } from "./canonical.js";

const CORE = "@agent-surface/core";
const COMPONENT_MACRO = "defineAgentComponentContract";
const PROCEDURE_MACRO = "defineAgentProcedureContract";
const EXTERNAL_MACRO = "defineExternalAgentToolContract";
const WRAPPERS = new Set([
  "observationContract",
  "actionContract",
  "fromJsonSchema",
  "defineAgentComponentContract",
  "defineAgentProcedureContract",
  "defineExternalAgentToolContract",
]);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface ExtractedModule {
  code: string;
  entries: CapabilityContractEntry[];
}

function sourceKind(id: string): ts.ScriptKind {
  if (/\.tsx(?:\?|$)/.test(id)) return ts.ScriptKind.TSX;
  if (/\.jsx(?:\?|$)/.test(id)) return ts.ScriptKind.JSX;
  if (/\.js(?:\?|$)/.test(id)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function unwrap(node: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

function propertyName(node: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  if (ts.isComputedPropertyName(node) && ts.isStringLiteral(unwrap(node.expression))) {
    return (unwrap(node.expression) as ts.StringLiteral).text;
  }
  return undefined;
}

function calleeName(node: ts.Expression): string | undefined {
  node = unwrap(node);
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression &&
    ts.isStringLiteral(unwrap(node.argumentExpression))
  ) {
    return (unwrap(node.argumentExpression) as ts.StringLiteral).text;
  }
  return undefined;
}

function normalizedOrigin(root: string, id: string): string {
  const clean = id.replace(/^\0/, "virtual:").split("?")[0]!;
  if (clean.startsWith("virtual:")) return clean;
  const path = clean.startsWith("/\@fs/") ? clean.slice(4) : clean;
  return posix.normalize(relative(root, resolve(path)).split("\\").join("/"));
}

class StaticEvaluator {
  private readonly constants = new Map<string, ts.Expression>();
  private readonly active = new Set<string>();

  constructor(private readonly file: ts.SourceFile) {
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        this.constants.set(node.name.text, node.initializer);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }

  evaluate(input: ts.Expression, where: string): Json {
    const node = unwrap(input);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
      const value = this.evaluate(node.operand, where);
      if (typeof value === "number") return -value;
    }
    if (ts.isArrayLiteralExpression(node)) {
      return node.elements.map((entry, index) => {
        if (ts.isSpreadElement(entry)) {
          const spread = this.evaluate(entry.expression, `${where}[${index}]`);
          if (!Array.isArray(spread)) throw this.failure(entry, `${where}: array spread is not static`);
          return spread;
        }
        return this.evaluate(entry as ts.Expression, `${where}[${index}]`);
      }).flat() as Json[];
    }
    if (ts.isObjectLiteralExpression(node)) {
      const result: Record<string, Json> = {};
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) {
          const spread = this.evaluate(property.expression, `${where} spread`);
          if (typeof spread !== "object" || spread === null || Array.isArray(spread)) {
            throw this.failure(property, `${where}: object spread is not static`);
          }
          Object.assign(result, spread);
          continue;
        }
        if (ts.isShorthandPropertyAssignment(property)) {
          result[property.name.text] = this.evaluate(property.name, `${where}.${property.name.text}`);
          continue;
        }
        if (!ts.isPropertyAssignment(property)) {
          throw this.failure(property, `${where}: methods/accessors are runtime code`);
        }
        const name = propertyName(property.name);
        if (name === undefined) throw this.failure(property.name, `${where}: computed key is not static`);
        result[name] = this.evaluate(property.initializer, `${where}.${name}`);
      }
      return result;
    }
    if (ts.isIdentifier(node)) {
      if (node.text === "undefined") throw this.failure(node, `${where}: undefined is not serializable`);
      if (node.text === "emptyObjectSchema") {
        return { type: "object", properties: {}, additionalProperties: false };
      }
      const value = this.constants.get(node.text);
      if (!value) throw this.failure(node, `${where}: imported/dynamic value "${node.text}" is not static`);
      if (this.active.has(node.text)) throw this.failure(node, `${where}: cyclic static value "${node.text}"`);
      this.active.add(node.text);
      try {
        return this.evaluate(value, where);
      } finally {
        this.active.delete(node.text);
      }
    }
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name && WRAPPERS.has(name) && node.arguments[0]) {
        return this.evaluate(node.arguments[0], where);
      }
      throw this.failure(node, `${where}: call "${name ?? "<computed>"}" is not a compiler macro`);
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const owner = this.evaluate(node.expression, where);
      const name = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : node.argumentExpression && ts.isStringLiteral(unwrap(node.argumentExpression))
          ? (unwrap(node.argumentExpression) as ts.StringLiteral).text
          : undefined;
      if (name !== undefined && typeof owner === "object" && owner !== null && !Array.isArray(owner)) {
        const value = owner[name];
        if (value !== undefined) return value;
      }
    }
    throw this.failure(node, `${where}: expression is dynamic or non-serializable`);
  }

  private failure(node: ts.Node, message: string): Error {
    const position = this.file.getLineAndCharacterOfPosition(node.getStart(this.file));
    return new Error(`${this.file.fileName}:${position.line + 1}:${position.character + 1}: ${message}`);
  }
}

function record(value: Json, where: string): Record<string, Json> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${where} must be a static object`);
  }
  return value;
}

function string(value: Json | undefined, where: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${where} must be a string`);
  return value;
}

function policies(value: Json | undefined): CapabilityPolicyAttachment[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("policies must be a static array");
  return value.map((entry) => record(entry, "policy")) as unknown as CapabilityPolicyAttachment[];
}

function combine<T>(inherited: readonly T[] | undefined, local: readonly T[] | undefined): T[] | undefined {
  const values = [...(inherited ?? []), ...(local ?? [])];
  if (values.length === 0) return undefined;
  const unique = new Map(values.map((value) => [canonicalJson(value), value]));
  return [...unique.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
}

function entryHash(entry: Omit<CapabilityContractEntry, "contractHash" | "targets">): string {
  return sha256(canonicalJson(entry));
}

function declarationVariable(call: ts.CallExpression): string | undefined {
  let node: ts.Node = call;
  while (
    node.parent &&
    (ts.isParenthesizedExpression(node.parent) ||
      ts.isAsExpression(node.parent) ||
      ts.isSatisfiesExpression(node.parent))
  ) {
    node = node.parent;
  }
  return node.parent && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)
    ? node.parent.name.text
    : undefined;
}

function isMacroCall(
  call: ts.CallExpression,
  names: ReadonlySet<string>,
  namespaces: ReadonlySet<string>,
  aliases: ReadonlyMap<string, string>,
): "component" | "procedure" | "external" | undefined {
  const expression = unwrap(call.expression);
  let imported: string | undefined;
  if (ts.isIdentifier(expression)) imported = aliases.get(expression.text);
  else if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    if (namespaces.has(expression.expression.text)) imported = expression.name.text;
  } else if (
    ts.isElementAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    namespaces.has(expression.expression.text) &&
    expression.argumentExpression &&
    ts.isStringLiteral(unwrap(expression.argumentExpression))
  ) {
    imported = (unwrap(expression.argumentExpression) as ts.StringLiteral).text;
  }
  if (imported === COMPONENT_MACRO) return "component";
  if (imported === PROCEDURE_MACRO) return "procedure";
  if (imported === EXTERNAL_MACRO) return "external";
  return undefined;
}

export function extractModule(options: {
  code: string;
  id: string;
  root: string;
  target: string;
  placeholder: string;
}): ExtractedModule {
  const file = ts.createSourceFile(options.id, options.code, ts.ScriptTarget.Latest, true, sourceKind(options.id));
  const namespaces = new Set<string>();
  const aliases = new Map<string, string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== CORE || !statement.importClause) continue;
    const bindings = statement.importClause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        aliases.set(binding.name.text, binding.propertyName?.text ?? binding.name.text);
      }
    }
  }
  // Assigned aliases are resolved transitively within the module.
  let changed = true;
  while (changed) {
    changed = false;
    const visitAlias = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const init = unwrap(node.initializer);
        let source: string | undefined;
        if (ts.isIdentifier(init)) source = aliases.get(init.text);
        else if (ts.isPropertyAccessExpression(init) && ts.isIdentifier(init.expression) && namespaces.has(init.expression.text)) {
          source = init.name.text;
        }
        if (source && !aliases.has(node.name.text)) {
          aliases.set(node.name.text, source);
          changed = true;
        }
      }
      ts.forEachChild(node, visitAlias);
    };
    visitAlias(file);
  }

  const macroNames = new Set([COMPONENT_MACRO, PROCEDURE_MACRO, EXTERNAL_MACRO]);
  if (![...aliases.values()].some((name) => macroNames.has(name)) && namespaces.size === 0) {
    return { code: options.code, entries: [] };
  }

  const evaluator = new StaticEvaluator(file);
  const entries: CapabilityContractEntry[] = [];
  const injections: Array<{ position: number; text: string }> = [];
  const origin = normalizedOrigin(options.root, options.id);

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const macro = isMacroCall(node, macroNames, namespaces, aliases);
      if (macro) {
        if (!node.arguments[0]) throw new Error(`${origin}: contract declaration needs an argument`);
        const variable = declarationVariable(node);
        if (!variable) throw new Error(`${origin}: contract declaration must initialize a named module constant`);
        const declarationId = `${origin}#${variable}`;
        const definition = record(evaluator.evaluate(node.arguments[0], declarationId), declarationId);
        const emitted: CapabilityContractEntry[] = [];
        if (macro === "component") {
          const type = string(definition.type, `${declarationId}.type`);
          const inheritedPolicies = policies(definition.policies);
          const inheritedTags = definition.tags as string[] | undefined;
          const groups = [
            ["observations", "observation", "read"],
            ["actions", "action", undefined],
          ] as const;
          for (const [groupName, kind, defaultEffect] of groups) {
            const groupValue = definition[groupName];
            if (groupValue === undefined) continue;
            const group = record(groupValue, `${declarationId}.${groupName}`);
            for (const [name, rawMember] of Object.entries(group)) {
              const member = record(rawMember, `${declarationId}.${groupName}.${name}`);
              const capabilityPolicies = combine(inheritedPolicies, policies(member.policies));
              const capabilityTags = combine(inheritedTags, member.tags as string[] | undefined);
              const base = {
                declarationId,
                capabilityId: `view:${type}.${name}`,
                kind,
                description: string(member.description, `${declarationId}.${name}.description`),
                effect: string(member.effect ?? defaultEffect, `${declarationId}.${name}.effect`) as CapabilityContractEntry["effect"],
                ...(member.input ? { inputSchema: member.input as JsonSchema } : {}),
                ...(member.output ? { outputSchema: member.output as JsonSchema } : {}),
                ...(member.confirmation ? { confirmation: member.confirmation as "never" | "optional" | "required" } : {}),
                ...(capabilityPolicies ? { policies: capabilityPolicies } : {}),
                ...(capabilityTags ? { tags: capabilityTags } : {}),
                origin,
              } satisfies Omit<CapabilityContractEntry, "contractHash" | "targets">;
              emitted.push({ ...base, contractHash: entryHash(base), targets: [options.target] });
            }
          }
        } else {
          const id = string(definition.id, `${declarationId}.id`);
          const base = {
            declarationId,
            capabilityId: id,
            kind: macro === "procedure" ? "procedure" as const : "external" as const,
            description: string(definition.description, `${declarationId}.description`),
            effect: string(definition.effect, `${declarationId}.effect`) as CapabilityContractEntry["effect"],
            ...(definition.input ? { inputSchema: definition.input as JsonSchema } : {}),
            ...(definition.output ? { outputSchema: definition.output as JsonSchema } : {}),
            ...(definition.confirmation ? { confirmation: definition.confirmation as "never" | "optional" | "required" } : {}),
            ...(policies(definition.policies) ? { policies: policies(definition.policies) } : {}),
            ...(definition.tags ? { tags: definition.tags as string[] } : {}),
            origin,
          } satisfies Omit<CapabilityContractEntry, "contractHash" | "targets">;
          emitted.push({ ...base, contractHash: entryHash(base), targets: [options.target] });
        }
        entries.push(...emitted);
        if (node.arguments.length < 2) {
          if (macro === "component") {
            const capabilities: Record<string, CompiledCapabilityToken> = {};
            for (const entry of emitted) {
              capabilities[entry.capabilityId] = {
                manifestHash: options.placeholder,
                declarationId: entry.declarationId,
                capabilityId: entry.capabilityId,
                contractHash: entry.contractHash,
              };
            }
            const provenance: CompiledComponentProvenance = {
              manifestHash: options.placeholder,
              declarationId,
              capabilities,
            };
            injections.push({ position: node.arguments.end, text: `, ${JSON.stringify(provenance)}` });
          } else {
            const entry = emitted[0]!;
            const token: CompiledCapabilityToken = {
              manifestHash: options.placeholder,
              declarationId,
              capabilityId: entry.capabilityId,
              contractHash: entry.contractHash,
            };
            injections.push({ position: node.arguments.end, text: `, ${JSON.stringify(token)}` });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  let code = options.code;
  for (const injection of injections.sort((a, b) => b.position - a.position)) {
    code = `${code.slice(0, injection.position)}${injection.text}${code.slice(injection.position)}`;
  }
  return { code, entries };
}
