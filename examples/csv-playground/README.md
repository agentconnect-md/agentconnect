# CSV to JSON playground

A small dependency-free browser example. It handles quoted commas, escaped quotes, multiline fields, and CRLF input. Every value stays a string. Header mode creates objects from the first row; data mode returns arrays. Rows with inconsistent column counts or invalid quotes show a line-numbered error.

Serve this directory with any static file server, then open its URL. For example, from the repository root:

```sh
python3 -m http.server 8000 --directory examples/csv-playground
```

Open <http://localhost:8000>. Run the focused tests with:

```sh
node --test examples/csv-playground/parse-csv.test.mjs
```
