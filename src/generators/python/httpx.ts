import { Word, eq } from "../../shell/Word.ts";
import { CCError } from "../../utils.ts";
import { parse as parseLosslessJson } from "lossless-json";
import { parse, getFirst, COMMON_SUPPORTED_ARGS } from "../../parse.ts";
import type { Request, Warnings } from "../../parse.ts";
import { parseQueryString, type QueryDict } from "../../Query.ts";
import {
  repr,
  reprStr,
  asFloat,
  formatDataAsJson,
  printImports,
  type OSVars,
} from "./python.ts";

export const supportedArgs = new Set([
  ...COMMON_SUPPORTED_ARGS,
  "insecure",
  "no-insecure",
  "location",
  "no-location",
  "max-time",
  "digest",
  "no-digest",
  "upload-file",
  "http1.1",
]);

function extractCookies(
  request: Request,
  warnings: Warnings,
): QueryDict | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  const cookies: QueryDict = [];
  const values = new Map<string, Word>();
  let deduplicated = false;
  for (const segment of header.split(";")) {
    const cookie = segment.trim();
    // Browsers and copied commands can include trailing or empty separators.
    if (cookie.isEmpty()) continue;
    const [name, value] = cookie.split("=", 2);
    if (value === undefined || !name.isString() || name.isEmpty()) {
      warnings.push([
        "httpx-cookie-header",
        "Cookie header retained: malformed cookies or dynamic names cannot be safely represented by cookies=.",
      ]);
      return undefined;
    }
    const previous = values.get(name.toString());
    if (previous !== undefined) {
      if (previous.isString() && value.isString() && eq(previous, value)) {
        deduplicated = true;
        continue;
      }
      warnings.push([
        "httpx-cookie-header",
        "Cookie header retained: repeated names with conflicting or dynamic values cannot be safely represented by cookies=.",
      ]);
      return undefined;
    }
    values.set(name.toString(), value);
    cookies.push([name, value]);
  }
  if (deduplicated) {
    warnings.push([
      "httpx-cookie-duplicate",
      "Identical repeated cookies were combined in cookies=. The original Cookie header is preserved as a comment.",
    ]);
  }
  return cookies.length ? cookies : undefined;
}

function formatHttpxHeaders(
  headers: Array<[Word, Word | null]>,
  osVars: OSVars,
  imports: Set<string>,
  extractCookie: boolean,
): string {
  if (!headers.length) return "None";
  const simple =
    headers.every(
      ([key, value]) =>
        key.isString() &&
        value!.isString() &&
        /^[\x00-\x7f]*$/.test(key.toString() + value!.toString()),
    ) &&
    new Set(headers.map(([key]) => key.toString())).size === headers.length;
  // Preserve repeated names and non-ASCII values with byte tuples.
  const lines = headers.map(([key, value]) => {
    if (extractCookie && eq(key.toLowerCase(), "cookie")) {
      const entry =
        reprStr(key.toString()) +
        (simple ? ": " : ", ") +
        reprStr(value!.toString());
      return "    # " + (simple ? entry : "(" + entry + ")") + ",";
    }
    return simple
      ? "    " +
          repr(key, osVars, imports) +
          ": " +
          repr(value!, osVars, imports) +
          ","
      : "    (" +
          repr(key, osVars, imports, true) +
          ", " +
          repr(value!, osVars, imports, true) +
          "),";
  });
  return [simple ? "{" : "[", ...lines, simple ? "}" : "]"].join("\n");
}

function renderRequest(
  values: Record<string, string>,
  bodyName: string,
  body: string,
  imports: Set<string>,
  osVars: OSVars,
): string {
  const { url, method, timeout, verify, follow_redirects, ...fields } = values;
  const blocks = Object.entries(osVars).map(
    ([name, value]) => name + " = " + value,
  );
  const args = [method, url];
  const clientArgs: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value === "None") continue;
    blocks.push(name + " = " + value);
    args.push(name + "=" + name);
  }
  if (body !== "None") {
    const variable = bodyName === "json" ? "json_data" : bodyName;
    blocks.push(variable + " = " + body);
    args.push(bodyName + "=" + variable);
  }
  clientArgs.push("timeout=" + timeout);
  if (verify === "False") clientArgs.push("verify=False");
  if (follow_redirects === "True") clientArgs.push("follow_redirects=True");
  const client = "client = httpx.Client(" + clientArgs.join(", ") + ")";
  const clientCode =
    client.length <= 80
      ? client
      : [
          "client = httpx.Client(",
          ...clientArgs.map((arg) => "    " + arg + ","),
          ")",
        ].join("\n");
  blocks.splice(Object.keys(osVars).length, 0, clientCode);
  const call = "response = client.request(" + args.join(", ") + ")";
  blocks.push(
    call.length <= 80
      ? call
      : [
          "response = client.request(",
          ...args.map((arg) => "    " + arg + ","),
          ")",
        ].join("\n"),
  );
  return (
    printImports(imports) + "import httpx\n\n" + blocks.join("\n\n") + "\n"
  );
}

function formatDictionary(
  entries: QueryDict,
  osVars: OSVars,
  imports: Set<string>,
): string {
  const py = (word: Word) => repr(word, osVars, imports);
  return (
    "{\n" +
    entries
      .map(
        ([key, value]) =>
          "    " +
          py(key) +
          ": " +
          (Array.isArray(value)
            ? "[" + value.map(py).join(", ") + "]"
            : py(value)) +
          ",\n",
      )
      .join("") +
    "}"
  );
}

function formatBody(
  request: Request,
  warnings: Warnings,
  osVars: OSVars,
  imports: Set<string>,
): [string, string] {
  const target = request.urls[0];
  const readFile = (filename: Word) => {
    if (eq(filename, "-") || (eq(filename, ".") && target.uploadFile)) {
      imports.add("sys");
      return "sys.stdin.buffer.read()";
    }
    imports.add("pathlib");
    return "pathlib.Path(" + repr(filename, osVars, imports) + ").read_bytes()";
  };

  let bodyName = "content";
  let body = "None";
  if (target.uploadFile) {
    body = readFile(target.uploadFile);
  } else if (request.dataArray) {
    const contentType = request.headers.getContentType();
    const literal = request.dataArray.every((part) => part instanceof Word);
    if (literal && request.data) {
      // The shared formatter falls back to JSON.parse, which discards duplicate
      // keys. Validate first so these bodies stay byte-for-byte intact.
      let uniqueJson = false;
      if (request.data.isString()) {
        try {
          parseLosslessJson(request.data.toString());
          uniqueJson = true;
        } catch {
          // Invalid JSON and duplicate keys are sent as raw content.
        }
      }
      const [jsonCode] =
        uniqueJson &&
        (contentType === "application/json" || contentType?.endsWith("+json"))
          ? formatDataAsJson(request.data, imports, osVars)
          : [null];
      const [, form] =
        contentType === "application/x-www-form-urlencoded"
          ? parseQueryString(request.data)
          : [null, null];
      if (jsonCode && jsonCode !== "json_data = None\n") {
        bodyName = "json";
        body = jsonCode.slice("json_data = ".length).trimEnd();
        warnings.push([
          "httpx-json-format",
          "JSON is reserialized by HTTPX. Use content= with the original bytes if exact formatting matters.",
        ]);
      } else if (form && form.every(([key]) => key.isString())) {
        bodyName = "data";
        body = formatDictionary(form, osVars, imports);
      } else {
        body = repr(request.data, osVars, imports, true);
      }
    } else {
      body =
        request.dataArray
          .map((part) => {
            if (part instanceof Word) return repr(part, osVars, imports, true);
            let value = readFile(part.filename);
            if (part.filetype === "data") {
              value +=
                ".replace(b'\\r', b'').replace(b'\\n', b'').replace(b'\\x00', b'')";
            } else if (part.filetype === "urlencode") {
              imports.add("urllib.parse");
              value =
                "parse.quote_from_bytes(" +
                value +
                ", safe='').replace('%20', '+').encode()";
              if (part.name)
                value =
                  repr(part.name, osVars, imports, true) + " + b'=' + " + value;
            }
            return value;
          })
          .join(" + ") || "b''";
    }
  }
  if (request.multipartUploads && !request.data) {
    // Do not silently produce a request with a missing multipart body.
    throw new CCError("Python HTTPX multipart forms are not supported yet");
  }
  return [bodyName, body];
}

// Generate from the parsed request, never by rewriting Requests source code.
export function _toPythonHttpx(
  requests: Request[],
  warnings: Warnings = [],
): string {
  const request = getFirst(requests, warnings);
  const target = request.urls[0];
  const imports = new Set<string>();
  const osVars: OSVars = {};
  const py = (word: Word) => repr(word, osVars, imports);

  const cookies = extractCookies(request, warnings);
  const headers = request.headers.headers.filter(([, value]) => value !== null);
  const query = target.queryDict?.every(([key]) => key.isString())
    ? target.queryDict
    : undefined;
  const defaults: Record<string, string> = {
    url: py(query ? target.urlWithoutQueryList : target.url),
    method: py(target.method),
    headers: formatHttpxHeaders(
      headers,
      osVars,
      imports,
      cookies !== undefined,
    ),
    cookies: cookies ? formatDictionary(cookies, osVars, imports) : "None",
    params: query ? formatDictionary(query, osVars, imports) : "None",
  };
  if (target.queryList && !target.queryDict) {
    warnings.push([
      "httpx-query-order",
      "Query retained in the URL to preserve the order of repeated parameters.",
    ]);
  }
  const [bodyName, body] = formatBody(request, warnings, osVars, imports);
  if (request.cookieFiles?.length) {
    warnings.push([
      "httpx-cookie-file",
      "Loading cookies from a file is not supported; pass cookies= explicitly.",
    ]);
  }
  const auth = target.auth
    ? "(" + target.auth.map(py).join(", ") + ")"
    : "None";
  defaults.auth =
    request.authType === "digest" && target.auth
      ? "httpx.DigestAuth" + auth
      : auth;
  defaults.timeout =
    request.timeout && !eq(request.timeout, "0")
      ? asFloat(request.timeout, osVars, imports)
      : "None";
  defaults.verify = request.insecure ? "False" : "True";
  defaults.follow_redirects = request.followRedirects ? "True" : "False";
  return renderRequest(defaults, bodyName, body, imports, osVars);
}

export function toPythonHttpxWarn(
  curlCommand: string | string[],
  warnings: Warnings = [],
): [string, Warnings] {
  return [
    _toPythonHttpx(parse(curlCommand, supportedArgs, warnings), warnings),
    warnings,
  ];
}

export function toPythonHttpx(curlCommand: string | string[]): string {
  return toPythonHttpxWarn(curlCommand)[0];
}
