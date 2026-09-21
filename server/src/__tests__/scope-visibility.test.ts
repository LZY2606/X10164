import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import * as LSP from 'vscode-languageserver/node'
import { TextDocument } from 'vscode-languageserver-textdocument'

import { FIXTURE_FOLDER } from '../../../testing/fixtures'
import { getMockConnection } from '../../../testing/mocks'
import LspServer from '../server'
import { Logger } from '../util/logger'

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {
  // noop
})

const FIXTURE_DIR = join(FIXTURE_FOLDER, 'scope-visibility')
const MAIN_URI = pathToFileURL(join(FIXTURE_DIR, 'main.sh')).href
const LIB_URI = pathToFileURL(join(FIXTURE_DIR, 'lib.sh')).href
const DYNAMIC_URI = pathToFileURL(join(FIXTURE_DIR, 'dynamic-source')).href

// main.sh: `  echo "$SHARED_TOKEN"` – cursor inside the variable name.
const SHARED_TOKEN_POSITION = { line: 8, character: 10 }
// main.sh: `  echo "$SHADOWED_VALUE"` – cursor inside the variable name.
const SHADOWED_VALUE_POSITION = { line: 7, character: 10 }

async function initializeServer({
  initializationOptions,
}: {
  initializationOptions?: unknown
} = {}) {
  const connection = getMockConnection()

  const server = await LspServer.initialize(connection, {
    rootPath: pathToFileURL(FIXTURE_FOLDER).href,
    rootUri: null,
    processId: 42,
    capabilities: {},
    workspaceFolders: null,
    initializationOptions: {
      // Keep the test hermetic: no background scan, no external tools.
      backgroundAnalysisMaxFiles: 0,
      shellcheckPath: '',
      ...((initializationOptions ?? {}) as Record<string, unknown>),
    },
  })

  server.register(connection)
  const onInitialized = connection.onInitialized.mock.calls[0][0]
  await onInitialized({})

  const didOpen = (uri: string, text: string, version = 1) =>
    connection.onDidOpenTextDocument.mock.calls[0][0]({
      textDocument: { uri, languageId: 'shellscript', version, text },
    })

  const didChange = (uri: string, text: string, version: number) =>
    connection.onDidChangeTextDocument.mock.calls[0][0]({
      textDocument: { uri, version },
      contentChanges: [{ text }],
    })

  const onDefinition = (params: LSP.TextDocumentPositionParams) =>
    connection.onDefinition.mock.calls[0][0](params, {} as any, {} as any, {} as any)

  const onReferences = (params: LSP.ReferenceParams) =>
    connection.onReferences.mock.calls[0][0](params, {} as any, {} as any, {} as any)

  const onCompletion = (params: LSP.TextDocumentPositionParams) =>
    connection.onCompletion.mock.calls[0][0](params, {} as any, {} as any, {} as any)

  const onRenameRequest = (params: LSP.RenameParams) =>
    connection.onRenameRequest.mock.calls[0][0](params, {} as any, {} as any, {} as any)

  const onWorkspaceSymbol = (params: LSP.WorkspaceSymbolParams) =>
    connection.onWorkspaceSymbol.mock.calls[0][0](params, {} as any, {} as any, {} as any)

  return {
    connection,
    server,
    didOpen,
    didChange,
    onDefinition,
    onReferences,
    onCompletion,
    onRenameRequest,
    onWorkspaceSymbol,
  }
}

function readFixtureText(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8')
}

describe('scope-visibility: one visible symbol set across requests', () => {
  it('definition, references, completion and rename agree on a sourced global', async () => {
    const { didOpen, onDefinition, onReferences, onCompletion, onRenameRequest } =
      await initializeServer()

    didOpen(MAIN_URI, readFixtureText('main.sh'))

    const textDocument = { uri: MAIN_URI }
    const position = SHARED_TOKEN_POSITION

    const definition = (await onDefinition({
      textDocument,
      position,
    })) as LSP.Location[]
    expect(definition).toEqual([
      {
        uri: LIB_URI,
        range: { start: { line: 4, character: 0 }, end: { line: 4, character: 23 } },
      },
    ])

    const references = (await onReferences({
      textDocument,
      position,
      context: { includeDeclaration: true },
    })) as LSP.Location[]
    expect(references).toHaveLength(3)
    // The declaration reported by definition is part of the reference set.
    // Note: definition reports the range of the whole assignment statement,
    // while references reports the variable name token, so we compare the
    // symbol (uri + line), not the exact range.
    expect(
      references.some((l) => l.uri === definition[0].uri && l.range.start.line === 4),
    ).toBe(true)
    expect(references).toContainEqual({
      uri: MAIN_URI,
      range: { start: { line: 8, character: 9 }, end: { line: 8, character: 21 } },
    })
    expect(references).toContainEqual({
      uri: LIB_URI,
      range: { start: { line: 11, character: 9 }, end: { line: 11, character: 21 } },
    })

    const completion = (await onCompletion({
      textDocument,
      position,
    })) as LSP.CompletionItem[]
    const sharedTokenItems = completion.filter((item) => item.label === 'SHARED_TOKEN')
    expect(sharedTokenItems).toHaveLength(1)
    expect(sharedTokenItems[0].kind).toEqual(LSP.CompletionItemKind.Variable)

    const renameEdit = (await onRenameRequest({
      textDocument,
      position,
      newName: 'RENAMED_TOKEN',
    })) as LSP.WorkspaceEdit
    const changes = renameEdit.changes ?? {}
    // The rename touches exactly the files where the symbol is visible.
    expect(Object.keys(changes).sort()).toEqual([LIB_URI, MAIN_URI].sort())

    // The rename edit set is exactly the reference set: no invisible
    // same-named symbol is rewritten.
    const renameRanges = Object.entries(changes).flatMap(([uri, edits]) =>
      (edits as LSP.TextEdit[]).map((edit) => ({ uri, range: edit.range })),
    )
    const sortLocations = (locations: Array<{ uri: string; range: LSP.Range }>) =>
      [...locations].map((l) => JSON.stringify(l)).sort()
    expect(sortLocations(renameRanges)).toEqual(sortLocations(references))
    for (const edits of Object.values(changes)) {
      for (const edit of edits as LSP.TextEdit[]) {
        expect(edit.newText).toEqual('RENAMED_TOKEN')
      }
    }
  })

  it('a function-local variable shadows the sourced global for definition and rename', async () => {
    const { didOpen, onDefinition, onRenameRequest } = await initializeServer()

    didOpen(MAIN_URI, readFixtureText('main.sh'))

    const textDocument = { uri: MAIN_URI }
    const position = SHADOWED_VALUE_POSITION

    const definition = (await onDefinition({
      textDocument,
      position,
    })) as LSP.Location[]
    // The function-local declaration is the preferred (first) result.
    expect(definition[0].uri).toEqual(MAIN_URI)
    expect(definition[0].range.start.line).toEqual(6)

    const renameEdit = (await onRenameRequest({
      textDocument,
      position,
      newName: 'RENAMED_LOCAL',
    })) as LSP.WorkspaceEdit
    const changes = renameEdit.changes ?? {}
    // File-wide rename scoped to the function body: the sourced global
    // SHADOWED_VALUE in lib.sh is invisible here and must not be rewritten.
    expect(Object.keys(changes)).toEqual([MAIN_URI])

    const updated = TextDocument.applyEdits(
      TextDocument.create(MAIN_URI, 'shellscript', 1, readFixtureText('main.sh')),
      changes[MAIN_URI] as LSP.TextEdit[],
    )
    expect(updated).toContain('local RENAMED_LOCAL="local-from-main"')
    expect(updated).toContain('echo "$RENAMED_LOCAL"')
    expect(updated).not.toContain('SHADOWED_VALUE')
  })

  it('re-analyzes a sourced file when it is edited (index invalidation)', async () => {
    const { didOpen, didChange, onDefinition, onWorkspaceSymbol } =
      await initializeServer()

    const libText = readFixtureText('lib.sh')
    didOpen(MAIN_URI, readFixtureText('main.sh'))
    didOpen(LIB_URI, libText)

    const textDocument = { uri: MAIN_URI }
    const position = SHARED_TOKEN_POSITION

    const before = (await onDefinition({ textDocument, position })) as LSP.Location[]
    expect(before).toHaveLength(1)
    expect(before[0].uri).toEqual(LIB_URI)

    // Edit the sourced file: the declaration of SHARED_TOKEN is removed and a
    // new symbol is added. The cached analysis of lib.sh must be replaced.
    const editedLibText = libText.replace('SHARED_TOKEN="from-lib"', 'ADDED_BY_EDIT=1')
    didChange(LIB_URI, editedLibText, 2)

    const after = (await onDefinition({ textDocument, position })) as LSP.Location[]
    expect(after).toEqual([])

    const workspaceSymbols = (await onWorkspaceSymbol({
      query: 'ADDED_BY_EDIT',
    })) as LSP.SymbolInformation[]
    expect(workspaceSymbols).toHaveLength(1)
    expect(workspaceSymbols[0].location.uri).toEqual(LIB_URI)
  })

  it('a dynamic source path degrades to an explainable conservative result', async () => {
    // The "system directory" that the environment variable points at. The
    // server must not resolve the variable nor scan this directory.
    const externalDir = mkdtempSync(join(tmpdir(), 'bls-dynamic-source-'))
    writeFileSync(join(externalDir, 'extra.sh'), 'DYNAMIC_ONLY_SYMBOL="from-dynamic"\n')
    process.env.DYNAMIC_FIXTURE_DIR = externalDir

    try {
      const { connection, didOpen, onDefinition, onCompletion } = await initializeServer({
        initializationOptions: { enableSourceErrorDiagnostics: true },
      })

      didOpen(DYNAMIC_URI, readFixtureText('dynamic-source'))

      // The unresolvable source command is reported, not silently followed.
      const diagnosticsCalls = connection.sendDiagnostics.mock.calls.filter(
        ([params]) => params.uri === DYNAMIC_URI,
      )
      const allDiagnostics = diagnosticsCalls.flatMap(([params]) => params.diagnostics)
      expect(
        allDiagnostics.some(
          (d) =>
            typeof d.message === 'string' &&
            d.message.includes('Source command could not be analyzed'),
        ),
      ).toBe(true)

      const textDocument = { uri: DYNAMIC_URI }
      const position = { line: 8, character: 10 }

      // No declaration is invented for the symbol that only exists behind the
      // dynamic source path.
      const definition = (await onDefinition({
        textDocument,
        position,
      })) as LSP.Location[]
      expect(definition).toEqual([])

      const completion = (await onCompletion({
        textDocument,
        position,
      })) as LSP.CompletionItem[]
      expect(completion.some((item) => item.label === 'DYNAMIC_ONLY_SYMBOL')).toBe(false)
    } finally {
      delete process.env.DYNAMIC_FIXTURE_DIR
      rmSync(externalDir, { recursive: true, force: true })
    }
  })
})
