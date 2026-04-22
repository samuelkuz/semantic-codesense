# Semantic CodeSense

Semantic CodeSense is a VS Code extension scaffold for exploring AI-assisted mental-model comments for Rust code. The Rust comment generation itself is not implemented yet; this repo sets up the structure, command surface, and extension plumbing needed to build it cleanly.

## What is scaffolded

- A TypeScript-based VS Code extension project
- A placeholder command for generating a mental-model comment
- A Rust-oriented symbol graph model for functions, structs, enums, traits, impls, methods, and modules
- Rust-specific extension hooks via Code Actions and optional CodeLens
- Basic configuration, output logging, and source organization
- Unit-test scaffolding for graph extraction, context lookup, and placeholder generation flow
- Launch and task files for local extension development in VS Code

## Commands

- `Semantic CodeSense: Generate Mental Model Comment`
- `Semantic CodeSense: Show Rust Graph Debug View`
- `Semantic CodeSense: Show Rust Symbol Context`

Today this command only confirms that the extension wiring is working and that AI generation has not been implemented yet.
The debug command opens a JSON view of the current Rust file's parsed syntax model, graph nodes and edges, selected-symbol context, Cargo workspace summary, and any rust-analyzer/LSP data available at the cursor.
The symbol context command opens a Markdown report for the symbol under the cursor with core context, dependency context, and usage context gathered from the augmented Rust graph plus rust-analyzer.

## Project layout

- `src/extension.ts`: extension activation entrypoint
- `src/commands/`: user-invoked VS Code commands
- `src/features/rust/`: Rust-specific editor integrations, graph building, and symbol lookup
- `src/services/`: future AI service boundary
- `src/core/`: shared configuration and logging helpers
- `src/types/graph.ts`: repository graph backbone types
- `src/test/`: unit tests for the current scaffolding

## Local development

```bash
npm install
npm run compile
```

Then open the project in VS Code and press `F5` to launch an Extension Development Host.

## Testing On A Rust Repo

1. Open this extension project in VS Code.
2. Press `F5` to launch the Extension Development Host.
3. In the Extension Development Host, open any Rust workspace or repo.
4. Open a `.rs` file and place your cursor inside a function or method.
5. Run `Semantic CodeSense: Show Rust Graph Debug View` from the Command Palette.
6. Run `Semantic CodeSense: Show Rust Symbol Context` to inspect the retrieval-style context report for the symbol under your cursor.

That debug view is the easiest way to inspect what the extension currently understands about the file.

## Retrieval backbone

The Rust graph builder now creates:

- `SymbolNode` records for modules, structs, enums, traits, impl blocks, functions, and methods
- `belongs_to`, `calls`, `called_by`, `uses_type`, `implements`, and `imports` edges
- A `SymbolContext` view so a selected function or method can resolve its parent chain, callees, callers, and touched types
- A layered Rust parsing stack: VS Code/LSP for navigation metadata, Tree-sitter Rust for syntax extraction, and `cargo metadata` hooks for workspace/package context

The syntax layer now uses Tree-sitter Rust rather than regex-first parsing for symbol discovery. LSP and Cargo metadata adapters are also in place so future retrieval can enrich symbols with references, hover content, definitions, call hierarchy, and workspace context without changing the graph model.

## Suggested next steps

- Expand from file-level graph building to multi-file repo graph assembly
- Merge LSP call hierarchy and reference data into the graph as higher-confidence edges when rust-analyzer is active
- Use Cargo workspace metadata to improve crate-relative module path resolution
- Add a real AI provider client and prompt pipeline behind `CommentGenerationService`
- Insert generated comments through workspace edits with reviewable diffs
- Add extension host tests once the editor workflow is implemented
