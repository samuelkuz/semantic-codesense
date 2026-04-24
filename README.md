# Semantic CodeSense

Semantic CodeSense is a VS Code extension for building mental models of Rust code. It analyzes the symbol under your cursor, gathers structural evidence from the file and editor tooling, runs a bounded analysis loop, and renders a Markdown summary through a local Ollama model.

The project is still early-stage, but it is no longer just command scaffolding. The Rust graph, evidence collection pipeline, analysis orchestration, and Ollama-backed summary generation are all wired up today.

## Current capabilities

- Rust-only VS Code extension workflow
- Cursor-based symbol inspection for functions, methods, impls, traits, enums, structs, and modules
- Tree-sitter Rust parsing for syntax-aware symbol and relationship extraction
- Rust graph construction with edges such as `belongs_to`, `calls`, `called_by`, `uses_type`, `implements`, and `imports`
- LSP and `cargo metadata` augmentation hooks for richer context
- Evidence collection, retrieval planning, ranking, and bounded multi-round analysis
- Ollama-backed semantic summaries rendered as Markdown in a side editor
- Debug and inspection commands for graph payloads and symbol-context reports
- Unit tests for parsing, retrieval, ranking, orchestration, and summary formatting

## Commands

- `Semantic CodeSense: Generate Mental Model Comment`
  Builds a Rust symbol-context report, runs the analysis loop, sends ranked evidence to Ollama, and opens a Markdown semantic summary.
- `Semantic CodeSense: Show Rust Graph Debug View`
  Opens a JSON document with syntax output, graph nodes and edges, Cargo workspace data, selected-symbol context, and LSP snapshot data.
- `Semantic CodeSense: Show Rust Symbol Context`
  Opens a Markdown report for the symbol under the cursor, including parent context, dependency context, and usage context.

These commands are available from the Command Palette and the Rust editor context menu. An optional CodeLens entry can also surface the generate command above supported Rust symbols.

## Requirements

- VS Code `^1.95.0`
- Node.js and npm for local development
- A Rust workspace to inspect
- A local Ollama server if you want generated summaries

Without Ollama, the graph and symbol-context inspection commands still work, but summary generation will fail when it tries to call the configured Ollama endpoint.

## Configuration

The extension contributes these settings under `semanticCodesense`:

- `semanticCodesense.enabled`
  Enable or disable Semantic CodeSense for Rust files.
- `semanticCodesense.commentTone`
  Reserved for future tone control. Current values: `concise`, `balanced`, `detailed`.
- `semanticCodesense.logLevel`
  Output channel verbosity: `error`, `warn`, `info`, `debug`.
- `semanticCodesense.showCodeLens`
  Shows CodeLens actions above supported Rust symbols when enabled.
- `semanticCodesense.ollamaBaseUrl`
  Ollama base URL. Default: `http://localhost:11434`
- `semanticCodesense.ollamaModel`
  Ollama model name for hypothesis and summary generation. Default: `qwen3-coder:30b`

## Local development

```bash
npm install
npm run compile
```

Useful scripts:

- `npm run watch`
- `npm run lint`
- `npm test`

To run the extension locally:

1. Open this repo in VS Code.
2. Press `F5` to launch an Extension Development Host.
3. In the new window, open a Rust workspace.
4. Open a `.rs` file and place the cursor on a symbol of interest.
5. Run one of the Semantic CodeSense commands from the Command Palette or editor context menu.

## Trying it against the sample Rust workspace

This repo includes [`test-rust-code`](/Users/samkuz/Coding/semantic-codesense/test-rust-code), a compact Rust crate designed to exercise the analysis pipeline.

Some good symbols to inspect:

- `services::OrderProcessor::process_order`
- `services::OrderProcessor::finalize_order`
- `review::should_queue_manual_review`
- `routing::route_fulfillment_lane`
- `repository::InMemoryOrderRepository::append_audit`

Start with `Show Rust Symbol Context` to see what the extension has collected, then use `Generate Mental Model Comment` once Ollama is running.

## Project layout

- [`src/extension.ts`](/Users/samkuz/Coding/semantic-codesense/src/extension.ts): activation entrypoint
- [`src/commands/`](/Users/samkuz/Coding/semantic-codesense/src/commands): user-facing VS Code commands
- [`src/features/rust/`](/Users/samkuz/Coding/semantic-codesense/src/features/rust): Rust parsing, graph building, LSP augmentation, and context collection
- [`src/evidence/`](/Users/samkuz/Coding/semantic-codesense/src/evidence): evidence storage and orchestration
- [`src/retrieval/`](/Users/samkuz/Coding/semantic-codesense/src/retrieval): retrieval planning and evidence lookup
- [`src/ranking/`](/Users/samkuz/Coding/semantic-codesense/src/ranking): evidence ranking
- [`src/services/`](/Users/samkuz/Coding/semantic-codesense/src/services): Ollama-backed hypothesis and comment generation services
- [`src/analysis/`](/Users/samkuz/Coding/semantic-codesense/src/analysis): bounded analysis loop orchestration
- [`src/test/`](/Users/samkuz/Coding/semantic-codesense/src/test): unit tests

## How the pipeline works

1. Resolve the Rust symbol at the current cursor position.
2. Parse the file with Tree-sitter and build a symbol graph.
3. Enrich that graph with editor/LSP and Cargo workspace context where available.
4. Collect evidence artifacts about the target symbol and related symbols.
5. Run a bounded analysis loop that drafts hypotheses, plans retrieval, gathers more evidence, and ranks the result set.
6. Send the ranked evidence to Ollama and render the returned JSON as a Markdown semantic summary.

## Known limitations

- The extension is currently focused on Rust only.
- Summary generation depends on a reachable local Ollama server.
- Analysis is strongest for symbols that can be resolved from the active file and nearby graph context.
- Cross-file and whole-repository understanding is still evolving.

## Near-term direction

- Improve multi-file and crate-wide graph assembly
- Fold more rust-analyzer call/reference data into the evidence graph
- Improve Cargo-aware module-path and workspace resolution
- Add richer reviewable comment insertion workflows inside the editor
- Expand extension-host style integration coverage
