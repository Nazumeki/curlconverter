import { createServer } from "node:http";
import {
  toPythonHttpxWarn,
  toPythonWarn,
  toJavaScriptWarn,
} from "../dist/src/index.js";

const converters = {
  "python-httpx": toPythonHttpxWarn,
  python: toPythonWarn,
  javascript: toJavaScriptWarn,
};

const page = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>curlconverter dev preview</title>
<style>
  body { max-width: 960px; margin: 40px auto; padding: 0 20px; font: 16px/1.5 system-ui, sans-serif; }
  label { display: block; margin-top: 16px; }
  textarea { box-sizing: border-box; width: 100%; min-height: 160px; font: 14px/1.5 monospace; }
  button, select { padding: 8px 12px; margin: 8px 0; font: inherit; }
  pre { padding: 16px; background: #f1f3f5; overflow: auto; }
</style>
<h1>curlconverter dev preview</h1>
<p>Paste a Bash curl command to generate code. Conversion does not send the HTTP request.</p>
<form id="form">
  <label for="command">Curl command</label>
  <textarea id="command" spellcheck="false" required>curl https://example.com -H 'X-Test: value'</textarea>
  <label for="language">Output</label>
  <select id="language">
    <option value="python-httpx">Python HTTPX</option>
    <option value="python">Python Requests</option>
    <option value="javascript">JavaScript Fetch</option>
  </select>
  <button type="submit">Convert</button>
</form>
<p id="status" role="status"></p>
<h2>Generated code</h2>
<pre id="code"></pre>
<h2>Warnings</h2>
<pre id="warnings"></pre>
<script>
  const form = document.getElementById('form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    document.getElementById('status').textContent = 'Converting…';
    document.getElementById('code').textContent = '';
    document.getElementById('warnings').textContent = '';
    try {
      const response = await fetch('/convert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: document.getElementById('command').value,
          language: document.getElementById('language').value,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      document.getElementById('code').textContent = result.code;
      document.getElementById('warnings').textContent =
        result.warnings.map(([kind, message]) => kind + ': ' + message).join('\\n') || 'None';
      document.getElementById('status').textContent = 'Converted.';
    } catch (error) {
      document.getElementById('status').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
</script>
</html>`;

const server = createServer(async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  if (request.method === "GET" && request.url === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(page);
    return;
  }
  if (request.method !== "POST" || request.url !== "/convert") {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  response.setHeader("Content-Type", "application/json; charset=utf-8");
  try {
    let body = "";
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 1_000_000) throw new Error("Command is too large");
    }
    const { command, language } = JSON.parse(body);
    if (typeof command !== "string" || !Object.hasOwn(converters, language)) {
      throw new Error("Provide a curl command and a supported output language");
    }
    const [code, warnings] = converters[language](command);
    response.end(JSON.stringify({ code, warnings }));
  } catch (error) {
    response.statusCode = 400;
    response.end(JSON.stringify({ error: error.message }));
  }
});

const port = Number(process.env.PORT || 3000);
server.listen(port, "127.0.0.1", () => {
  console.log(`Dev preview: http://127.0.0.1:${server.address().port}`);
});
