import test from "tape";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { toPythonHttpx, toPythonHttpxWarn } from "../src/index.ts";

// Run the generated script through HTTPX's encoder without network or file I/O.
function check(args: string[] | string, assertions: string): void {
  const code = toPythonHttpx(
    typeof args === "string" ? args : ["curl", "https://example.com", ...args],
  );
  const script = [
    "import httpx",
    "from unittest.mock import patch",
    "source = " + JSON.stringify(code),
    "namespace = {}",
    "options = {}",
    "def handle(request):",
    "    request.read()",
    "    return httpx.Response(200, request=request)",
    "class RecordingClient(httpx.Client):",
    "    def __init__(self, **kwargs):",
    "        assert 'cookies' not in kwargs",
    "        options.update(kwargs)",
    "        super().__init__(transport=httpx.MockTransport(handle), **kwargs)",
    "    def request(self, method, url, **kwargs):",
    "        if 'cookies' in namespace: assert kwargs['cookies'] == namespace['cookies']",
    "        options.update(kwargs)",
    "        return super().request(method, url, **kwargs)",
    "with patch('httpx.Client', RecordingClient), patch('pathlib.Path.read_bytes', return_value=b'a b&c\\r\\n\\x00'):",
    "    exec(source, namespace)",
    "assert not namespace['client'].is_closed",
    "namespace['client'].close()",
    "response = namespace['response'].request",
    assertions,
  ].join("\n");
  const result = spawnSync(process.env.PYTHON || "python", ["-c", script], {
    encoding: "utf8",
  });
  test(
    "HTTPX: " +
      (typeof args === "string"
        ? "browser cookies and form data"
        : args.join(" ")),
    (t) => {
      t.equal(
        result.status,
        0,
        result.stderr || String(result.error || "generated request is correct"),
      );
      t.end();
    },
  );
}

check([], "assert response.method == 'GET'\nassert options['timeout'] is None");
check(
  ["-H", "X-Test: value", "-b", "session=abc; theme=dark"],
  [
    "assert response.headers['x-test'] == 'value'",
    "assert response.headers['cookie'] == 'session=abc; theme=dark'",
    "assert namespace['headers'] == {'X-Test': 'value'}",
    "assert namespace['cookies'] == {'session': 'abc', 'theme': 'dark'}",
  ].join("\n"),
);
check(["-b", "a=1; a=2"], "assert response.headers['cookie'] == 'a=1; a=2'");
const browserCommand = readFileSync(
  "test/fixtures/curl_commands/httpx_duplicate_browser_cookies.sh",
  "utf8",
);
check(
  browserCommand,
  [
    "assert namespace['cookies'] == {'semester.id': '1082', 'JSESSIONID': 'test-session.-worker2', 'Array_xuanke': 'web65'}",
    "assert 'Cookie' not in namespace['headers']",
    "assert \"# 'Cookie':\" in source and 'Array_xuanke=web65; Array_xuanke=web65' in source",
    "assert response.headers['cookie'].count('Array_xuanke=web65') == 1",
    "assert response.method == 'POST'",
    "assert str(response.url) == 'https://jx.sspu.edu.cn/eams/stdElectCourse!queryStdCount.action'",
    "from urllib.parse import parse_qs",
    "assert parse_qs(response.content.decode()) == {'lessonIds': [namespace['data']['lessonIds']]}",
    "assert namespace['data']['lessonIds'].endswith('208456,')",
  ].join("\n"),
);
test("HTTPX explains cookie normalization", (t) => {
  const [, warnings] = toPythonHttpxWarn(browserCommand);
  t.deepEqual(
    warnings.map(([kind]) => kind),
    ["httpx-cookie-duplicate"],
  );
  const [, conflicting] = toPythonHttpxWarn([
    "curl",
    "https://example.com",
    "-b",
    "a=1; a=2",
  ]);
  t.ok(conflicting.some(([kind]) => kind === "httpx-cookie-header"));
  t.end();
});
for (const flag of ["-H", "-b"]) {
  check(
    [flag, (flag === "-H" ? "Cookie: " : "") + "session=abc;  theme=dark; ;"],
    [
      "assert namespace['cookies'] == {'session': 'abc', 'theme': 'dark'}",
      "assert options['headers'] == {}",
      "assert '# ' in source and 'session=abc;  theme=dark; ;' in source",
      "assert response.headers['cookie'] == 'session=abc; theme=dark'",
    ].join("\n"),
  );
}
check(
  ["-H", "cOoKiE: session=abc==; empty=; token=a%3Db", "-H", "X-Test: value"],
  [
    "assert namespace['cookies'] == {'session': 'abc==', 'empty': '', 'token': 'a%3Db'}",
    "assert namespace['headers'] == {'X-Test': 'value'}",
    "assert options['cookies'] == namespace['cookies']",
    "assert not any(name.lower() == 'cookie' for name in options['headers'])",
    "assert response.headers.get_list('cookie') == ['session=abc==; empty=; token=a%3Db']",
  ].join("\n"),
);
check(
  ["-H", "Cookie: session"],
  "assert 'cookies' not in options\nassert response.headers['cookie'] == 'session'",
);
check(
  ["-H", "X-Test: café"],
  "assert (b'X-Test', 'café'.encode()) in response.headers.raw",
);
check(
  ["--max-time", "12", "-k", "-L"],
  [
    "assert options['timeout'] == 12",
    "assert options['verify'] is False",
    "assert options['follow_redirects'] is True",
  ].join("\n"),
);
check(
  ["-d", "a=1&a=2&blank="],
  [
    "assert response.content == b'a=1&a=2&blank='",
    "assert namespace['data'] == {'a': ['1', '2'], 'blank': ''}",
    "assert 'json' not in options and 'content' not in options",
  ].join("\n"),
);
check(["-d", "a=1&b=2&a=3"], "assert response.content == b'a=1&b=2&a=3'");
check(
  ["--url-query", "a=1", "--url-query", "a=2", "--url-query", "blank="],
  [
    "assert response.url.query == b'a=1&a=2&blank='",
    "assert namespace['params'] == {'a': ['1', '2'], 'blank': ''}",
  ].join("\n"),
);
check(
  ["--url-query", "a=1", "--url-query", "b=2", "--url-query", "a=3"],
  "assert response.url.query == b'a=1&b=2&a=3'",
);
check(
  ["--json", '{"n":9007199254740993,"ok":true,"values":[null,false]}'],
  [
    "import json",
    "expected = {'n': 9007199254740993, 'ok': True, 'values': [None, False]}",
    "assert json.loads(response.content) == expected",
    "assert namespace['json_data'] == expected",
    "assert 'data' not in options and 'content' not in options",
  ].join("\n"),
);
for (const value of [
  "null",
  "false",
  "0",
  '""',
  "[]",
  "{broken",
  '{"a":1,"a":2}',
  "1e999",
]) {
  check(
    ["--json", value],
    "assert response.content == " + JSON.stringify(value) + ".encode()",
  );
}
check(
  ["-X", "GET", "--data-binary", "hello"],
  "assert response.method == 'GET'\nassert response.content == b'hello'",
);
check(["-d", ""], "assert response.content == b''");
check(
  ["--data-binary", "@file", "-d", "suffix=1"],
  "assert response.content == b'a b&c\\r\\n\\x00&suffix=1'",
);
check(
  ["--data-urlencode", "field@file"],
  "assert response.content == b'field=a+b%26c%0D%0A%00'",
);
check(["-d", "@file"], "assert response.content == b'a b&c'");
