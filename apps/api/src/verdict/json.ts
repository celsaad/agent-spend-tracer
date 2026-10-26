/**
 * A strict JSON parser for verdict headers and payloads (draft-dias-agent-payment-verdicts-00,
 * Section 6, step 1). JSON.parse doesn't do what the procedure needs:
 * - it keeps the last of duplicate member names silently; here duplicates at any depth reject,
 *   so no two parses can disagree about which member they read;
 * - it reads every number as binary64; here numbers keep their literal text (JsonNumber), so
 *   amounts can be compared by decimal value (step 9);
 * - it has no nesting bound; here depth is bounded before anything is verified.
 */

/** A JSON number, kept as written. */
export class JsonNumber {
  constructor(readonly raw: string) {}
}

export type JsonValue = string | JsonNumber | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export class JsonError extends Error {}

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

export function parseJson(text: string, maxDepth: number): JsonValue {
  let i = 0;

  const fail = (msg: string): never => {
    throw new JsonError(`${msg} at offset ${i}`);
  };
  const skipWhitespace = () => {
    while (i < text.length && " \t\n\r".includes(text[i]!)) i++;
  };
  const expect = (literal: string) => {
    if (text.startsWith(literal, i)) i += literal.length;
    else fail(`expected ${literal}`);
  };

  function parseString(): string {
    expect('"');
    let out = "";
    while (true) {
      if (i >= text.length) fail("unterminated string");
      const c = text[i++]!;
      if (c === '"') return out;
      if (c === "\\") {
        const e = text[i++];
        switch (e) {
          case '"':
          case "\\":
          case "/":
            out += e;
            break;
          case "b":
            out += "\b";
            break;
          case "f":
            out += "\f";
            break;
          case "n":
            out += "\n";
            break;
          case "r":
            out += "\r";
            break;
          case "t":
            out += "\t";
            break;
          case "u": {
            const hex = text.slice(i, i + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("bad \\u escape");
            out += String.fromCharCode(parseInt(hex, 16));
            i += 4;
            break;
          }
          default:
            fail("bad escape");
        }
      } else if (c < " ") {
        fail("control character in string");
      } else {
        out += c;
      }
    }
  }

  function parseValue(depth: number): JsonValue {
    skipWhitespace();
    const c = text[i];
    if (c === "{" || c === "[") {
      if (depth >= maxDepth) fail(`nesting deeper than ${maxDepth}`);
      return c === "{" ? parseObject(depth + 1) : parseArray(depth + 1);
    }
    if (c === '"') return parseString();
    if (c === "t") return expect("true"), true;
    if (c === "f") return expect("false"), false;
    if (c === "n") return expect("null"), null;
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    if (!m) return fail("unexpected character");
    i += m[0].length;
    return new JsonNumber(m[0]);
  }

  function parseObject(depth: number): JsonObject {
    expect("{");
    // a null-prototype object, so "__proto__" is an ordinary member name
    const obj: JsonObject = Object.create(null);
    skipWhitespace();
    if (text[i] === "}") return i++, obj;
    while (true) {
      skipWhitespace();
      const key = parseString();
      if (Object.hasOwn(obj, key)) fail(`duplicate member "${key}"`);
      skipWhitespace();
      expect(":");
      obj[key] = parseValue(depth);
      skipWhitespace();
      if (text[i] === ",") i++;
      else return expect("}"), obj;
    }
  }

  function parseArray(depth: number): JsonValue[] {
    expect("[");
    const arr: JsonValue[] = [];
    skipWhitespace();
    if (text[i] === "]") return i++, arr;
    while (true) {
      arr.push(parseValue(depth));
      skipWhitespace();
      if (text[i] === ",") i++;
      else return expect("]"), arr;
    }
  }

  const value = parseValue(0);
  skipWhitespace();
  if (i !== text.length) fail("trailing characters");
  return value;
}

export const isObject = (v: JsonValue | undefined): v is JsonObject =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof JsonNumber);
