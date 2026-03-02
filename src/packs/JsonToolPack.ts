/**
 * JsonToolPack — structured JSON read/write tools for sandbox agents.
 *
 * Mounts at /tools/json/ via ToolGroupPack.
 *
 * Tools:
 *   json/get  — read a value at a JSON Pointer (RFC 6901) without loading the whole file
 *   json/set  — atomically set a value at a pointer; creates intermediate nodes as needed
 *   json/del  — remove a key or array element at a pointer
 *
 * All three tools support an array find-by-key extension:
 *   /tasks[id=S4_scene_expansion]/status
 *   resolves by finding the first array element where element.id === "S4_scene_expansion",
 *   making pointers stable even if array order changes.
 *
 * Security is delegated to the Sandbox instance.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Sandbox } from '../sandbox/Sandbox.js';
import { ToolGroupPack, type Tool } from '../sandbox/ToolGroupPack.js';
import type { SandboxLayer } from '../sandbox/layer.js';

// ─── Pointer parsing ─────────────────────────────────────────────

interface Segment {
    key: string;
    filter?: { key: string; value: string };
}

/**
 * Parse a single pointer segment.
 * "tasks[id=S4_scene_expansion]" → { key: "tasks", filter: { key: "id", value: "S4_scene_expansion" } }
 * "status" → { key: "status" }
 */
function parseSegment(raw: string): Segment {
    const m = raw.match(/^([^\[]+)\[([^=\]]+)=([^\]]*)\]$/);
    if (m) return { key: m[1]!, filter: { key: m[2]!, value: m[3]! } };
    return { key: raw };
}

/**
 * Split a JSON Pointer (RFC 6901) into decoded segments.
 * Returns null for the root pointer "".
 */
function parsePointer(pointer: string): Segment[] | null {
    if (pointer === '') return null; // root
    if (!pointer.startsWith('/')) {
        throw new Error(`JSON Pointer must start with '/' or be empty (root). Got: "${pointer}"`);
    }
    return pointer
        .slice(1)
        .split('/')
        .map(p => parseSegment(p.replace(/~1/g, '/').replace(/~0/g, '~')));
}

/** Resolve a segment against a value, returning [parent, key] for mutation or the final child. */
function stepInto(current: unknown, seg: Segment, pointerSoFar: string): unknown {
    if (Array.isArray(current)) {
        if (seg.filter) {
            // find-by-key extension: navigate into .key first, then filter
            const arr = (current as unknown[])[parseInt(seg.key, 10)] ?? current;
            // If .key is numeric, the filter was meant to be on the parent. Re-interpret:
            // The segment "tasks[id=foo]" means: navigate into "tasks" (which is an array),
            // then find the element where element.id === "foo".
            // But if current IS already an array and seg.key is not numeric, this is wrong.
            throw new Error(
                `Filter segment "${seg.key}[${seg.filter.key}=${seg.filter.value}]" encountered while already inside an array at "${pointerSoFar}"`
            );
        }
        const idx = parseInt(seg.key, 10);
        if (!Number.isInteger(idx) || idx < 0) {
            throw new Error(`Expected array index at "${pointerSoFar}/${seg.key}", got non-integer`);
        }
        return (current as unknown[])[idx];
    }

    if (current !== null && typeof current === 'object') {
        const obj = current as Record<string, unknown>;
        const child = obj[seg.key];
        if (seg.filter) {
            // child must be an array; find first element where element[filter.key] === filter.value
            if (!Array.isArray(child)) {
                throw new Error(
                    `Filter "${seg.key}[${seg.filter.key}=${seg.filter.value}]": "${seg.key}" is not an array at "${pointerSoFar}"`
                );
            }
            const match = (child as unknown[]).find(
                el => el !== null && typeof el === 'object' &&
                    String((el as Record<string, unknown>)[seg.filter!.key]) === seg.filter!.value
            );
            if (match === undefined) {
                throw new Error(
                    `Filter "${seg.key}[${seg.filter.key}=${seg.filter.value}]": no element with ${seg.filter.key}="${seg.filter.value}" at "${pointerSoFar}"`
                );
            }
            return match;
        }
        return child;
    }

    throw new Error(`Cannot traverse into ${JSON.stringify(current)} at "${pointerSoFar}"`);
}

// ─── Read ─────────────────────────────────────────────────────────

/** Resolve pointer against parsed JSON. Returns { found, value }. */
function getAt(root: unknown, segments: Segment[]): { found: boolean; value: unknown } {
    let current: unknown = root;
    let ptr = '';
    for (const seg of segments) {
        if (current === undefined || current === null) return { found: false, value: undefined };
        try {
            current = stepInto(current, seg, ptr);
            ptr += `/${seg.key}`;
        } catch {
            return { found: false, value: undefined };
        }
    }
    return { found: current !== undefined, value: current };
}

// ─── Write ────────────────────────────────────────────────────────

/**
 * Return a deep-cloned root with the value at pointer set.
 * Creates intermediate objects/arrays as needed.
 */
function setAt(root: unknown, segments: Segment[], value: unknown): unknown {
    if (segments.length === 0) return value; // replace root

    const cloned: unknown = JSON.parse(JSON.stringify(root ?? {}));

    // Walk to the parent of the target node, collecting mutable references.
    function walk(node: unknown, depth: number): unknown {
        const seg = segments[depth]!;
        const isLast = depth === segments.length - 1;

        if (Array.isArray(node)) {
            if (seg.filter) throw new Error(`Cannot use filter segment on an array directly`);
            const idx = parseInt(seg.key, 10);
            if (!Number.isInteger(idx) || idx < 0) throw new Error(`Expected array index, got "${seg.key}"`);
            const arr = [...(node as unknown[])];
            if (isLast) {
                arr[idx] = value;
            } else {
                const nextSeg = segments[depth + 1]!;
                const child = arr[idx] ?? (nextSeg.filter || isNaN(parseInt(nextSeg.key, 10)) ? {} : []);
                arr[idx] = walk(child, depth + 1);
            }
            return arr;
        }

        const obj = { ...(node as Record<string, unknown>) };

        if (seg.filter) {
            // The filter resolves to a specific array element; we need to update it in-place.
            const arr = obj[seg.key];
            if (!Array.isArray(arr)) throw new Error(`"${seg.key}" is not an array`);
            const newArr = [...arr];
            const idx = newArr.findIndex(
                el => el !== null && typeof el === 'object' &&
                    String((el as Record<string, unknown>)[seg.filter!.key]) === seg.filter!.value
            );
            if (idx < 0) throw new Error(`No element with ${seg.filter.key}="${seg.filter.value}" in "${seg.key}"`);
            if (isLast) {
                newArr[idx] = value; // replace the matched element entirely
            } else {
                newArr[idx] = walk(newArr[idx], depth + 1);
            }
            obj[seg.key] = newArr;
            return obj;
        }

        if (isLast) {
            obj[seg.key] = value;
        } else {
            const nextSeg = segments[depth + 1]!;
            const child = obj[seg.key] ?? (nextSeg.filter || isNaN(parseInt(nextSeg.key, 10)) ? {} : []);
            obj[seg.key] = walk(child, depth + 1);
        }
        return obj;
    }

    return walk(cloned, 0);
}

/**
 * Return a deep-cloned root with the node at pointer removed.
 * Returns { root, found }.
 */
function delAt(root: unknown, segments: Segment[]): { root: unknown; found: boolean } {
    if (segments.length === 0) return { root: undefined, found: true };

    let found = false;

    function walk(node: unknown, depth: number): unknown {
        const seg = segments[depth]!;
        const isLast = depth === segments.length - 1;

        if (Array.isArray(node)) {
            if (seg.filter) throw new Error(`Cannot use filter segment on an array directly`);
            const idx = parseInt(seg.key, 10);
            if (!Number.isInteger(idx) || idx < 0 || idx >= (node as unknown[]).length) return node;
            const arr = [...(node as unknown[])];
            if (isLast) {
                arr.splice(idx, 1);
                found = true;
            } else {
                arr[idx] = walk(arr[idx], depth + 1);
            }
            return arr;
        }

        const obj = { ...(node as Record<string, unknown>) };

        if (seg.filter) {
            const arr = obj[seg.key];
            if (!Array.isArray(arr)) return node;
            const newArr = [...arr];
            const matchIdx = newArr.findIndex(
                el => el !== null && typeof el === 'object' &&
                    String((el as Record<string, unknown>)[seg.filter!.key]) === seg.filter!.value
            );
            if (matchIdx < 0) return node;
            if (isLast) {
                newArr.splice(matchIdx, 1);
                found = true;
            } else {
                newArr[matchIdx] = walk(newArr[matchIdx], depth + 1);
            }
            obj[seg.key] = newArr;
            return obj;
        }

        if (!Object.prototype.hasOwnProperty.call(obj, seg.key)) return node;
        if (isLast) {
            delete obj[seg.key];
            found = true;
        } else {
            obj[seg.key] = walk(obj[seg.key], depth + 1);
        }
        return obj;
    }

    const result = walk(JSON.parse(JSON.stringify(root ?? {})), 0);
    return { root: result, found };
}

// ─── I/O helpers ──────────────────────────────────────────────────

function readJson(realPath: string): unknown {
    const raw = fs.readFileSync(realPath, 'utf-8');
    try {
        return JSON.parse(raw);
    } catch (e) {
        throw new Error(`Failed to parse JSON at ${realPath}: ${String(e)}`);
    }
}

function writeJson(realPath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(realPath), { recursive: true });
    fs.writeFileSync(realPath, JSON.stringify(value, null, 2) + '\n', 'utf-8');
}

function requireString(args: Record<string, unknown>, key: string): string {
    const v = args[key];
    if (typeof v !== 'string') throw new Error(`"${key}" must be a string`);
    return v;
}

function normAgentPath(raw: string): string {
    const p = path.normalize(raw);
    if (!path.isAbsolute(p)) throw new Error(`Path must be absolute, got: ${raw}`);
    return p;
}

// ─── JSON Schema validator ────────────────────────────────────────

interface SchemaError { path: string; message: string }

/**
 * Minimal JSON Schema validator (no external deps).
 * Supported keywords: type, required, properties, additionalProperties,
 * items, enum, minLength, maxLength, minimum, maximum.
 */
function validateSchema(
    value: unknown,
    schema: Record<string, unknown>,
    pointer: string,
    errors: SchemaError[],
): void {
    // type
    if (schema['type'] !== undefined) {
        const types = Array.isArray(schema['type']) ? schema['type'] : [schema['type']];
        const actual = value === null ? 'null'
            : Array.isArray(value) ? 'array'
            : typeof value;
        const ok = (types as string[]).some(t =>
            t === actual || (t === 'integer' && typeof value === 'number' && Number.isInteger(value)),
        );
        if (!ok) {
            errors.push({ path: pointer, message: `expected type ${types.join('|')}, got ${actual}` });
            return; // further checks are meaningless on wrong type
        }
    }
    // enum
    if (Array.isArray(schema['enum'])) {
        const allowed = schema['enum'] as unknown[];
        if (!allowed.some(v => JSON.stringify(v) === JSON.stringify(value))) {
            errors.push({ path: pointer, message: `value not in enum: ${JSON.stringify(value)}` });
        }
    }
    // string constraints
    if (typeof value === 'string') {
        if (typeof schema['minLength'] === 'number' && value.length < schema['minLength']) {
            errors.push({ path: pointer, message: `length ${value.length} < minLength ${schema['minLength']}` });
        }
        if (typeof schema['maxLength'] === 'number' && value.length > schema['maxLength']) {
            errors.push({ path: pointer, message: `length ${value.length} > maxLength ${schema['maxLength']}` });
        }
    }
    // number constraints
    if (typeof value === 'number') {
        if (typeof schema['minimum'] === 'number' && value < schema['minimum']) {
            errors.push({ path: pointer, message: `${value} < minimum ${schema['minimum']}` });
        }
        if (typeof schema['maximum'] === 'number' && value > schema['maximum']) {
            errors.push({ path: pointer, message: `${value} > maximum ${schema['maximum']}` });
        }
    }
    // object constraints
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const obj = value as Record<string, unknown>;
        if (Array.isArray(schema['required'])) {
            for (const key of schema['required'] as string[]) {
                if (!(key in obj)) {
                    errors.push({ path: pointer, message: `missing required property "${key}"` });
                }
            }
        }
        const props = schema['properties'];
        if (props !== null && typeof props === 'object' && !Array.isArray(props)) {
            for (const [key, subSchema] of Object.entries(props as Record<string, unknown>)) {
                if (key in obj) {
                    validateSchema(obj[key], subSchema as Record<string, unknown>, `${pointer}/${key}`, errors);
                }
            }
        }
        if (schema['additionalProperties'] === false && props !== null && typeof props === 'object') {
            const known = new Set(Object.keys(props as Record<string, unknown>));
            for (const key of Object.keys(obj)) {
                if (!known.has(key)) {
                    errors.push({ path: `${pointer}/${key}`, message: `additional property not allowed` });
                }
            }
        }
    }
    // array constraints
    if (Array.isArray(value) && schema['items'] !== undefined) {
        const itemSchema = schema['items'] as Record<string, unknown>;
        for (let i = 0; i < value.length; i++) {
            validateSchema(value[i], itemSchema, `${pointer}/${i}`, errors);
        }
    }
}

// ─── JsonToolPack ────────────────────────────────────────────────

export class JsonToolPack {
    constructor(private readonly sandbox: Sandbox) {}

    createLayer(): SandboxLayer {
        return new ToolGroupPack('json', [
            this.getTool(),
            this.setTool(),
            this.delTool(),
            this.validateTool(),
        ]).createLayer();
    }

    // ── json/get ─────────────────────────────────────────────────

    private getTool(): Tool {
        const { sandbox } = this;
        return {
            name: 'get',
            description: [
                'Read a single value from a JSON file using a JSON Pointer (RFC 6901).',
                'Pointer "/" is the root; "/tasks/0/status" reads a nested field.',
                'Supports find-by-key: "/tasks[id=S4_scene_expansion]/status".',
                'Returns { found, value } — value is null when found=false.',
            ].join(' '),
            parameters: {
                path: {
                    type: 'string',
                    description: 'Absolute sandbox path to the JSON file',
                    required: true,
                },
                pointer: {
                    type: 'string',
                    description: 'JSON Pointer to the target value (e.g. "/tasks/0/status" or "" for the whole document)',
                    required: true,
                },
            },
            returns: '{ found, value }',
            handler: async (args) => {
                const agentPath = normAgentPath(requireString(args, 'path'));
                const pointer   = requireString(args, 'pointer');

                const realPath = sandbox.resolveExisting(agentPath);
                const root     = readJson(realPath);
                const segments = parsePointer(pointer);

                if (segments === null) return { found: true, value: root };
                const { found, value } = getAt(root, segments);
                return { found, value: found ? value : null };
            },
        };
    }

    // ── json/set ─────────────────────────────────────────────────

    private setTool(): Tool {
        const { sandbox } = this;
        return {
            name: 'set',
            description: [
                'Set a value at a JSON Pointer path in a JSON file (atomic read-modify-write).',
                'Creates intermediate objects/arrays as needed.',
                'Supports find-by-key: "/tasks[id=S4_scene_expansion]/status".',
                'Use "" as pointer to replace the entire document.',
            ].join(' '),
            parameters: {
                path: {
                    type: 'string',
                    description: 'Absolute sandbox path to the JSON file (created if absent)',
                    required: true,
                },
                pointer: {
                    type: 'string',
                    description: 'JSON Pointer to the target location (e.g. "/tasks/0/status")',
                    required: true,
                },
                value: {
                    type: 'any',
                    description: 'Value to write (any JSON-serialisable type)',
                    required: true,
                },
            },
            returns: '{ ok, path, pointer }',
            handler: async (args, callerHandle) => {
                const agentPath = normAgentPath(requireString(args, 'path'));
                const pointer   = requireString(args, 'pointer');
                const value     = args['value'] !== undefined ? args['value'] : null;

                sandbox.assertWritable(agentPath, callerHandle);
                const realPath = sandbox.resolveForWrite(agentPath);

                let root: unknown = {};
                if (fs.existsSync(realPath)) {
                    root = readJson(realPath);
                }

                const segments = parsePointer(pointer);
                const updated  = setAt(root, segments ?? [], value);
                writeJson(realPath, updated);

                return { ok: true, path: agentPath, pointer };
            },
        };
    }

    // ── json/del ─────────────────────────────────────────────────

    private delTool(): Tool {
        const { sandbox } = this;
        return {
            name: 'del',
            description: [
                'Remove a key or array element at a JSON Pointer path.',
                'Supports find-by-key: "/tasks[id=old_task]".',
                'Returns { found: false } if the pointer did not exist — never errors on missing.',
            ].join(' '),
            parameters: {
                path: {
                    type: 'string',
                    description: 'Absolute sandbox path to the JSON file',
                    required: true,
                },
                pointer: {
                    type: 'string',
                    description: 'JSON Pointer to the node to remove (e.g. "/tasks/2" or "/lock")',
                    required: true,
                },
            },
            returns: '{ ok, found, path, pointer }',
            handler: async (args, callerHandle) => {
                const agentPath = normAgentPath(requireString(args, 'path'));
                const pointer   = requireString(args, 'pointer');

                sandbox.assertWritable(agentPath, callerHandle);
                const realPath = sandbox.resolveForWrite(agentPath);

                if (!fs.existsSync(realPath)) {
                    return { ok: true, found: false, path: agentPath, pointer };
                }

                const root     = readJson(realPath);
                const segments = parsePointer(pointer);
                if (segments === null) {
                    // Deleting root — write empty object
                    writeJson(realPath, {});
                    return { ok: true, found: true, path: agentPath, pointer };
                }

                const { root: updated, found } = delAt(root, segments);
                if (found) writeJson(realPath, updated);

                return { ok: true, found, path: agentPath, pointer };
            },
        };
    }

    // ── json/validate ─────────────────────────────────────────────

    private validateTool(): Tool {
        const { sandbox } = this;
        return {
            name: 'validate',
            description: [
                'Validate a JSON file against a JSON Schema file.',
                'Schema supports: type, required, properties, additionalProperties, items, enum,',
                'minLength, maxLength, minimum, maximum.',
                'Returns { valid: true } or { valid: false, errors: [{ path, message }] }.',
            ].join(' '),
            parameters: {
                path: {
                    type: 'string',
                    description: 'Absolute sandbox path to the JSON file to validate',
                    required: true,
                },
                schema: {
                    type: 'string',
                    description: 'Absolute sandbox path to the JSON Schema file',
                    required: true,
                },
            },
            returns: '{ valid, errors? }',
            handler: async (args) => {
                const agentPath    = normAgentPath(requireString(args, 'path'));
                const schemaPath   = normAgentPath(requireString(args, 'schema'));

                const realPath   = sandbox.resolveExisting(agentPath);
                const realSchema = sandbox.resolveExisting(schemaPath);

                const value  = readJson(realPath);
                const schema = readJson(realSchema);

                if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
                    throw new Error(`Schema at ${schemaPath} must be a JSON object`);
                }

                const errors: SchemaError[] = [];
                validateSchema(value, schema as Record<string, unknown>, '', errors);

                return errors.length === 0
                    ? { valid: true }
                    : { valid: false, errors };
            },
        };
    }
}
