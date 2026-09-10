# [curlconverter](https://curlconverter.com)

Transpile [`curl`](https://en.wikipedia.org/wiki/CURL) commands into C, C#, ColdFusion, Clojure, Dart, Elixir, Go, HTTPie, Java, JavaScript, Julia, Kotlin, Lua, MATLAB, Objective-C, OCaml, Perl, PHP, PowerShell, Python, R, Ruby, Rust, Swift, Wget, Ansible, HAR, HTTP or JSON.

Try it on [curlconverter.com](https://curlconverter.com) or as a drop-in `curl` replacement:

```shell
$ curlconverter --data "hello=world" example.com
import requests

data = {
    'hello': 'world',
}

response = requests.post('http://example.com', data=data)
```

Features:

- Implements a lot of curl's argument parsing logic
  - Knows about all 255 curl arguments but most are ignored
  - Supports shortening `-O -v -X POST` to `-OvXPOST`
  - `--data @filename` generates code that reads that file and `@-` reads stdin
- Understands Bash syntax
  - [ANSI-C quoted](https://www.gnu.org/software/bash/manual/bash.html#ANSI_002dC-Quoting) strings
  - stdin redirects and [heredocs](https://www.gnu.org/software/bash/manual/bash.html#Here-Documents)
  - Generated code reads environment variables and runs subcommands
  - Ignores comments
  - Reports syntax errors
- Converts JSON data to native objects
- Warns about issues with the conversion

Limitations:

- Only HTTP is supported
- Code generators for other languages are less thorough than the Python generator
- curl doesn't follow redirects or decompress gzip-compressed responses by default, but the generated code will do whatever the default is for that runtime, to keep it shorter. For example Python's Requests library [follows redirects by default](https://requests.readthedocs.io/en/latest/user/quickstart/#redirection-and-history), so unless you explicitly set the redirect policy with `-L`/`--location`/`--no-location`, the generated code will not handle redirects the same way as the curl command
- Shell variables can arbitrarily change how the command would be parsed at runtime. The command `curl $VAR` can do anything, depending on what's in `$VAR`. curlconverter assumes that environment variables don't contain characters that would affect parsing
- Only simple subcommands such as `curl $(echo example.com)` work, more complicated subcommands (such as nested commands or subcommands that redirect the output) won't generate valid code
- The Bash parser doesn't support all Bash syntax
- and much more

## Install

Install the command line tool with

```sh
npm install --global curlconverter
```

Install the JavaScript library for use in your own projects with

```sh
npm install curlconverter
```

## Usage

### Usage from the command line

`curlconverter` acts as a drop-in replacement for curl. Take any curl command, change "`curl`" to "`curlconverter`" and it will print code instead of making the request

```shell
$ curlconverter example.com
import requests

response = requests.get('http://example.com')
```

To read the curl command from stdin, pass `-`

```shell
$ echo 'curl example.com' | curlconverter -
import requests

response = requests.get('http://example.com')
```

Choose the output language by passing `--language <language>`. The options are

- `ansible`
- `c`
- `cfml`
- `clojure`
- `csharp`
- `dart`
- `elixir`
- `go`
- `har`
- `http`
- `httpie`
- `java`, `java-httpurlconnection`, `java-jsoup`, `java-okhttp`
- `javascript`, `javascript-jquery`, `javascript-xhr`
- `json`
- `julia`
- `kotlin`
- `lua`
- `matlab`
- `node`, `node-http`, `node-axios`, `node-got`, `node-ky`, `node-request`, `node-superagent`
- `objc`
- `ocaml`
- `perl`
- `php`, `php-guzzle`, `php-requests`
- `powershell`, `powershell-webrequest`
- `python` (the default), `python-http`, `python-httpx`
- `r`, `r-httr2`
- `ruby`, `ruby-httparty`
- `rust`
- `swift`
- `wget`

`--verbose` enables printing of conversion warnings and error tracebacks.

### Usage as a library

The JavaScript API is a bunch of functions that can take either a string of Bash code or an array of already-parsed arguments (like [`process.argv`](https://nodejs.org/docs/latest/api/process.html#processargv)) and return a string with the resulting program:

```js
import * as curlconverter from 'curlconverter';

curlconverter.toPython('curl example.com');
curlconverter.toPython(['curl', 'example.com']);
// "import requests\n\nresponse = requests.get('http://example.com')\n"
```

**Note**: add `"type": "module",` to your package.json for the `import` statement above to work. curlconverter must be imported as an ES module with `import` this way and not with `require()` because it uses [top-level `await`](https://v8.dev/features/top-level-await).

There's a corresponding set of functions that also return an array of warnings if there are any issues with the conversion:

```js
curlconverter.toPythonWarn('curl ftp://example.com');
curlconverter.toPythonWarn(['curl', 'ftp://example.com']);
// [
//   "import requests\n\nresponse = requests.get('ftp://example.com')\n",
//   [ [ 'bad-scheme', 'Protocol "ftp" not supported' ] ]
// ]
```

If you want to host curlconverter yourself and use it in the browser, it needs two [WASM](https://developer.mozilla.org/en-US/docs/WebAssembly) files to work, `tree-sitter.wasm` and `tree-sitter-bash.wasm`, which it will request from the root directory of your web server. If you are hosting a static website and using Webpack, you need to copy these files from the node_modules/ directory to your server's root directory in order to serve them. You can look at the [webpack.config.js](https://github.com/curlconverter/curlconverter.github.io/blob/2e1722891be22b1bb5c47976fb7873f6eb86b94d/webpack.config.js#L130-L131) for [curlconverter.com](https://curlconverter.com/) to see how this is done. You will also need to set `{module: {experiments: {topLevelAwait: true}}}` in your webpack.config.js.

### Python HTTPX

Use `curlconverter.toPythonHttpx(command)` (or `toPythonHttpxWarn` for
conversion warnings), or `curlconverter --language python-httpx` on the CLI.
Install `httpx` in your Python environment to run the generated code.

Like the Requests and http.client templates, the output is a standalone script:
imports, client creation, extracted variables, and a request through `httpx.Client`. Headers, cookies, query
parameters, and bodies are assigned only when present. Edit those variables or
the call arguments directly.

```python
import httpx

client = httpx.Client(timeout=None)

json_data = {'name': 'updated'}

response = client.request('POST', 'https://example.com', json=json_data)
```

Extracted cookies are passed explicitly as `cookies=cookies` to `client.request`, and the original Cookie header stays
commented out in `headers`. The client remains available for further requests;
call `client.close()` when finished with it.
The call uses `data=`, `json=`, or `content=` as appropriate for the body.
When changing body formats, also update `headers` if the
original Content-Type no longer applies. JSON is reserialized; a warning notes
that exact bytes require `content=` instead. JSON `null`, duplicate JSON keys,
and invalid JSON are kept as raw bytes. Queries with interleaved repeated keys
stay in the URL to preserve order; edit the URL to clear those queries.
Identical repeated cookies are combined, with a conversion warning. Repeated
names with conflicting values stay in the Cookie header to preserve their meaning.
Multipart forms are currently unsupported. Multiple requests use the first
request and emit a warning, consistent with the Python HTTP client generator.

Run the HTTPX encoder tests with `npm run test:httpx`. Set `PYTHON` to an
interpreter with `httpx` installed if it is not your default `python`.

### Usage in VS Code

There's a VS Code extension that adds a "Paste cURL as \<language\>" option to the right-click menu: [https://marketplace.visualstudio.com/items?itemName=curlconverter.curlconverter](https://marketplace.visualstudio.com/items?itemName=curlconverter.curlconverter). It doesn't support the same languages, curl arguments or Bash syntax as the current version because it has to [use an old version of curlconverter](https://github.com/curlconverter/curlconverter-vscode/issues/1).

## Contributing

For local web preview, CLI examples, and HTTPX transformer tests, see the
[developer guidebook](./DEVELOPMENT.md).

See [CONTRIBUTING.md](./CONTRIBUTING.md)

## License

MIT © [Nick Carneiro](http://trillworks.com)
