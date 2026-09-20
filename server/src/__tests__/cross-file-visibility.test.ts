import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as LSP from 'vscode-languageserver/node'
import { TextDocument } from 'vscode-languageserver-textdocument'

import { FIXTURE_FOLDER } from '../../../testing/fixtures'
import { getMockConnection } from '../../../testing/mocks'
import Analyzer from '../analyser'
import LspServer from '../server'
import { Logger } from '../util/logger'

const realSetTimeout = global.setTimeout
jest.spyOn(global, 'setTimeout').mockImplementation((fn: any, ms?: number) => {
  if (ms === 500) {
    fn()
    return 0 as any
  }
  return realSetTimeout(fn, ms)
})

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {
  // noop
})

const CROSS_FILE_FOLDER = join(FIXTURE_FOLDER, 'cross-file')
const MAIN_PATH = join(CROSS_FILE_FOLDER, 'main.sh')
const LIB_PATH = join(CROSS_FILE_FOLDER, 'lib.sh')
const EXCLUDED_PATH = join(
  CROSS_FILE_FOLDER,
  'node_modules',
  'excluded',
  'not-indexed.sh',
)

/**
 * Shared cursor for all four requests: the `CONFIG_PATH` inside the quoted
 * expansion on the last line of main.sh.
 */
const CURSOR: LSP.Position = { line: 3, character: 14 }
const NEW_NAME = 'CONFIG_TARGET'

/** The declaration every request must resolve to: the assignment in lib.sh. */
const declarationLocation = (libUri: string) =>
  LSP.Location.create(libUri, LSP.Range.create(1, 0, 1, 25))

async function initializeServer(configurationObject?: unknown) {
  const connection = getMockConnection()
  const server = await LspServer.initialize(connection, {
    rootPath: `file://${CROSS_FILE_FOLDER}`,
    rootUri: null,
    processId: 42,
    capabilities: { workspace: { configuration: true } },
  })
  ;(connection.workspace.getConfiguration as any).mockResolvedValue(
    configurationObject ?? {},
  )
  server.register(connection)
  const onInitialized = connection.onInitialized.mock.calls[0][0]
  const backgroundAnalysis = jest.spyOn(server as any, 'startBackgroundAnalysis')
  try {
    expect(await onInitialized({})).toBeUndefined()
    await backgroundAnalysis.mock.results[0].value
  } finally {
    backgroundAnalysis.mockRestore()
  }
  return { connection, server }
}

function open(
  connection: ReturnType<typeof getMockConnection>,
  uri: string,
  text: string,
) {
  connection.onDidOpenTextDocument.mock.calls[0][0]({
    textDocument: { uri, languageId: 'shellscript', version: 1, text },
  })
}

// ---------------------------------------------------------------------------
// Risk fixtures: each builds a minimal project, drives a real request handler
// and pins the current (conservative, non-crashing) answer.
// ---------------------------------------------------------------------------

async function initializeServerAt(rootPath: string, configurationObject?: unknown) {
  const connection = getMockConnection()
  const server = await LspServer.initialize(connection, {
    rootPath: `file://${rootPath}`,
    rootUri: null,
    processId: 42,
    capabilities: { workspace: { configuration: true } },
  })
  ;(connection.workspace.getConfiguration as any).mockResolvedValue(
    configurationObject ?? {},
  )
  server.register(connection)
  await connection.onInitialized.mock.calls[0][0]({})
  return { connection, server }
}

describe('cross-file symbol visibility', () => {
  it('answers definition, references, completion and rename from one visible symbol set', async () => {
    const { connection } = await initializeServer()
    const mainUri = `file://${MAIN_PATH}`
    const libUri = `file://${LIB_PATH}`
    const excludedUri = `file://${EXCLUDED_PATH}`
    open(connection, mainUri, readFileSync(MAIN_PATH, 'utf8'))

    const onDefinition = connection.onDefinition.mock.calls[0][0]
    const onReferences = connection.onReferences.mock.calls[0][0]
    const onCompletion = connection.onCompletion.mock.calls[0][0]
    const onRenameRequest = connection.onRenameRequest.mock.calls[0][0]

    const definition = await onDefinition(
      { textDocument: { uri: mainUri }, position: CURSOR },
      {} as any,
      {} as any,
    )

    expect(definition).toEqual([declarationLocation(libUri)])

    const references = onReferences(
      {
        textDocument: { uri: mainUri },
        position: CURSOR,
        context: { includeDeclaration: true },
      },
      {} as any,
      {} as any,
    )

    // Declaration and use in the sourced file plus the use in main.sh. The
    // node_modules copy is invisible because it is neither sourced nor part of
    // the workspace index.
    expect(references).toEqual([
      LSP.Location.create(libUri, LSP.Range.create(1, 0, 1, 11)),
      LSP.Location.create(libUri, LSP.Range.create(3, 9, 3, 20)),
      LSP.Location.create(mainUri, LSP.Range.create(3, 7, 3, 18)),
    ])
    expect(references as LSP.Location[]).not.toContainEqual(
      expect.objectContaining({ uri: excludedUri }),
    )

    const completion = (await onCompletion(
      // Completion is requested on the word prefix, like a real client does.
      { textDocument: { uri: mainUri }, position: { line: 3, character: 17 } },
      {} as any,
      {} as any,
    )) as Array<{ label: string }>
    const configCompletion = completion.filter((item) => item.label === 'CONFIG_PATH')
    expect(configCompletion).toHaveLength(1)

    const edit = (await onRenameRequest(
      { textDocument: { uri: mainUri }, position: CURSOR, newName: NEW_NAME },
      {} as any,
      {} as any,
    )) as LSP.WorkspaceEdit

    expect(Object.keys(edit.changes!).sort()).toEqual([libUri, mainUri])
    expect(edit.changes![libUri]).toEqual([
      LSP.TextEdit.replace(LSP.Range.create(1, 0, 1, 11), NEW_NAME),
      LSP.TextEdit.replace(LSP.Range.create(3, 9, 3, 20), NEW_NAME),
    ])
    expect(edit.changes![mainUri]).toEqual([
      LSP.TextEdit.replace(LSP.Range.create(3, 7, 3, 18), NEW_NAME),
    ])
    expect(edit.changes![excludedUri]).toBeUndefined()
  })

  it('drops stale symbols after the sourced file is edited and reanalyzed', async () => {
    const { connection } = await initializeServer()
    const mainUri = `file://${MAIN_PATH}`
    const libUri = `file://${LIB_PATH}`
    open(connection, mainUri, readFileSync(MAIN_PATH, 'utf8'))
    open(connection, libUri, readFileSync(LIB_PATH, 'utf8'))

    const onDefinition = connection.onDefinition.mock.calls[0][0]
    const onReferences = connection.onReferences.mock.calls[0][0]
    const onCompletion = connection.onCompletion.mock.calls[0][0]
    const onWorkspaceSymbol = connection.onWorkspaceSymbol.mock.calls[0][0]

    // Before the edit the sourced declaration resolves.
    expect(
      await onDefinition(
        { textDocument: { uri: mainUri }, position: CURSOR },
        {} as any,
        {} as any,
      ),
    ).toEqual([declarationLocation(libUri)])

    const newLib = [
      '#!/bin/bash',
      'CONFIG_PATH_AFTER_EDIT=/etc/app.conf',
      'print_config_path() {',
      '  echo "$CONFIG_PATH_AFTER_EDIT"',
      '}',
      '',
    ].join('\n')

    // Full-sync change, the same shape LSP clients send after editing lib.sh.
    connection.onDidChangeTextDocument.mock.calls[0][0]({
      textDocument: { uri: libUri, version: 2 },
      contentChanges: [{ text: newLib }],
    })

    // The old name no longer resolves into the sourced file...
    expect(
      await onDefinition(
        { textDocument: { uri: mainUri }, position: CURSOR },
        {} as any,
        {} as any,
      ),
    ).toEqual([])

    // ...its declaration disappears from the reference set...
    const references = onReferences(
      {
        textDocument: { uri: mainUri },
        position: CURSOR,
        context: { includeDeclaration: true },
      },
      {} as any,
      {} as any,
    )
    expect(references).toEqual([
      LSP.Location.create(mainUri, LSP.Range.create(3, 7, 3, 18)),
    ])

    // ...and completion follows the fresh contents as well.
    const completion = (await onCompletion(
      { textDocument: { uri: mainUri }, position: { line: 3, character: 17 } },
      {} as any,
      {} as any,
    )) as Array<{ label: string }>
    const labels = completion.map((item) => item.label)
    expect(labels).not.toContain('CONFIG_PATH')
    expect(labels).toContain('CONFIG_PATH_AFTER_EDIT')

    // The workspace index itself is rebuilt, not just the open-document view.
    const workspaceSymbols = (await onWorkspaceSymbol(
      { query: 'CONFIG_PATH' },
      {} as any,
      {} as any,
    )) as LSP.SymbolInformation[]
    expect(workspaceSymbols.map((symbol) => symbol.name)).not.toContain('CONFIG_PATH')
  })
})

describe('dynamic source paths', () => {
  it('degrades conservatively without probing environment-named directories', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bash-lsp-dynamic-source-'))
    const environmentDirectory = mkdtempSync(join(tmpdir(), 'bash-lsp-env-dir-'))
    const documentPath = join(root, 'dynamic.sh')
    const documentUri = `file://${documentPath}`
    const source = [
      'LIBDIR=./lib',
      'source "$LIBDIR/secret.sh"',
      'echo "$SECRET"',
      '',
    ].join('\n')
    writeFileSync(documentPath, source)
    // A file an attacker-controlled LIBDIR could point at outside the project.
    writeFileSync(join(environmentDirectory, 'secret.sh'), 'SECRET=system\n')

    const { connection, server } = await initializeServer({
      enableSourceErrorDiagnostics: true,
    })

    const exists = jest.spyOn(require('node:fs'), 'existsSync')

    try {
      await server.analyzeAndLintDocument(
        TextDocument.create(documentUri, 'shellscript', 1, source),
      )

      // Only the static suffix (relative to the script dir/workspace) may be
      // probed; the unknown expansion is never turned into an absolute probe.
      const probedPaths = exists.mock.calls.map(([filePath]) => String(filePath))
      expect(
        probedPaths.some((filePath) => filePath.startsWith(environmentDirectory)),
      ).toBe(false)

      const onDefinition = connection.onDefinition.mock.calls[0][0]
      const onRenameRequest = connection.onRenameRequest.mock.calls[0][0]

      // Nothing outside the static root candidates is ever resolved: the
      // environment variable value is not expanded into a filesystem probe.
      const position: LSP.Position = { line: 2, character: 9 }
      expect(
        await onDefinition(
          { textDocument: { uri: documentUri }, position },
          {} as any,
          {} as any,
        ),
      ).toEqual([])

      const edit = (await onRenameRequest(
        { textDocument: { uri: documentUri }, position, newName: 'SAFE' },
        {} as any,
        {} as any,
      )) as LSP.WorkspaceEdit
      // Rename stays within the file that contains the unresolved symbol.
      expect(Object.keys(edit.changes!)).toEqual([documentUri])

      const diagnostics = (connection.sendDiagnostics as unknown as jest.Mock).mock.calls
        .map(([params]) => params.diagnostics)
        .flat()
      expect(
        diagnostics.some(
          (diagnostic: LSP.Diagnostic) =>
            typeof diagnostic.message === 'string' &&
            diagnostic.message.startsWith('Source command could not be analyzed'),
        ),
      ).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(environmentDirectory, { recursive: true, force: true })
    }
  })
})

describe('source ring (risk 1)', () => {
  it('terminates and resolves the definition across the cycle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bash-lsp-source-ring-'))
    const aPath = join(root, 'a.sh')
    const bPath = join(root, 'b.sh')
    const aUri = `file://${aPath}`
    const bUri = `file://${bPath}`
    writeFileSync(aPath, 'source ./b.sh\nsay_hi\n')
    writeFileSync(bPath, 'source ./a.sh\nsay_hi() { echo hi; }\n')

    try {
      const { connection } = await initializeServerAt(root)
      open(connection, aUri, readFileSync(aPath, 'utf8'))
      open(connection, bUri, readFileSync(bPath, 'utf8'))

      const onDefinition = connection.onDefinition.mock.calls[0][0]
      const result = await onDefinition(
        {
          textDocument: { uri: aUri },
          position: { line: 1, character: 2 },
        },
        {} as any,
        {} as any,
      )

      // Exactly one stable target; traversal must not loop or return duplicates.
      expect(result).toEqual([LSP.Location.create(bUri, LSP.Range.create(1, 0, 1, 21))])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('same file through distinct paths (risk 2)', () => {
  it('deduplicates lexical relative paths, while symlink aliases remain separate', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bash-lsp-dup-path-'))
    const libPath = join(root, 'lib.sh')
    const m1Path = join(root, 'm1.sh')
    const subDirectory = join(root, 'sub')
    mkdirSync(subDirectory)
    const m2Path = join(subDirectory, 'm2.sh')
    writeFileSync(libPath, 'dup_func() { :; }\n')
    writeFileSync(m1Path, 'source ./lib.sh\ndup_func\n')
    writeFileSync(m2Path, 'source ../lib.sh\ndup_func\n')

    const { connection, server } = await initializeServerAt(root)
    const analyzer = (server as any).analyzer as Analyzer
    const m1Uri = `file://${m1Path}`
    const m2Uri = `file://${m2Path}`
    open(connection, m1Uri, readFileSync(m1Path, 'utf8'))
    open(connection, m2Uri, readFileSync(m2Path, 'utf8'))

    // Definition resolution pulls each document's source graph on demand;
    // both lexical relative spellings resolve to one canonical file URI.
    await connection.onDefinition.mock.calls[0][0](
      { textDocument: { uri: m1Uri }, position: { line: 1, character: 3 } },
      {} as any,
      {} as any,
    )
    await connection.onDefinition.mock.calls[0][0](
      { textDocument: { uri: m2Uri }, position: { line: 1, character: 3 } },
      {} as any,
      {} as any,
    )
    expect(
      Object.keys((analyzer as any).uriToAnalyzedDocument).filter((uri) =>
        uri.endsWith('lib.sh'),
      ),
    ).toEqual([`file://${libPath}`])

    // A directory symlink creates a second lexical URI for the same inode;
    // URIs are not canonicalized through realpath, so it stays a separate
    // index entry (documented duplication surface).
    const linkDirectory = join(root, 'alias')
    let symlinksSupported = true
    try {
      const { symlinkSync } = await import('node:fs')
      symlinkSync(root, linkDirectory, 'dir')
    } catch {
      symlinksSupported = false
    }

    if (symlinksSupported) {
      const linkedLibPath = join(linkDirectory, 'lib.sh')
      const linkedUri = `file://${linkedLibPath}`
      open(connection, linkedUri, readFileSync(linkedLibPath, 'utf8'))
      expect(Object.keys((analyzer as any).uriToAnalyzedDocument)).toContain(linkedUri)

      const references = connection.onReferences.mock.calls[0][0](
        {
          textDocument: { uri: linkedUri },
          position: { line: 0, character: 3 },
          context: { includeDeclaration: true },
        },
        {} as any,
        {} as any,
      ) as LSP.Location[]
      expect(
        references.filter((location) => location.uri.endsWith('lib.sh')),
      ).toHaveLength(2)
    }

    rmSync(root, { recursive: true, force: true })
  })
})

describe('function local shadowing a sourced global (risk 3)', () => {
  it('lets rename and completion stay local while definition/references widen', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bash-lsp-shadow-'))
    const libPath = join(root, 'lib.sh')
    const mainPath = join(root, 'main.sh')
    const libUri = `file://${libPath}`
    const mainUri = `file://${mainPath}`
    writeFileSync(libPath, 'VALUE=from_lib\necho "$VALUE"\n')
    writeFileSync(
      mainPath,
      [
        'source ./lib.sh',
        'f() {',
        '  local VALUE=local_value',
        '  echo "$VALUE"',
        '}',
        'f',
        'echo "$VALUE"',
        '',
      ].join('\n'),
    )

    try {
      const { connection } = await initializeServerAt(root)
      open(connection, mainUri, readFileSync(mainPath, 'utf8'))
      open(connection, libUri, readFileSync(libPath, 'utf8'))

      const position = { line: 3, character: 9 }

      // Rename is scope-aware: only the local declaration and its function-body
      // use are edited; the shadowed sourced global is untouched.
      const rename = (await connection.onRenameRequest.mock.calls[0][0](
        { textDocument: { uri: mainUri }, position, newName: 'VALUE2' },
        {} as any,
        {} as any,
      )) as LSP.WorkspaceEdit
      expect(Object.keys(rename.changes!)).toEqual([mainUri])
      expect(rename.changes![mainUri]).toEqual([
        LSP.TextEdit.replace(LSP.Range.create(2, 8, 2, 13), 'VALUE2'),
        LSP.TextEdit.replace(LSP.Range.create(3, 9, 3, 14), 'VALUE2'),
      ])
      expect(rename.changes![libUri]).toBeUndefined()

      // Definition lookup currently widens past the local and additionally
      // returns the shadowed sourced global. Pin it so a future scope fix must
      // update this test deliberately.
      const definition = await connection.onDefinition.mock.calls[0][0](
        { textDocument: { uri: mainUri }, position },
        {} as any,
        {} as any,
      )
      expect(definition).toEqual([
        LSP.Location.create(mainUri, LSP.Range.create(2, 8, 2, 25)),
        LSP.Location.create(libUri, LSP.Range.create(0, 0, 0, 14)),
      ])

      // References are global by design and include both scopes.
      const references = connection.onReferences.mock.calls[0][0](
        {
          textDocument: { uri: mainUri },
          position,
          context: { includeDeclaration: true },
        },
        {} as any,
        {} as any,
      )
      const uris = new Set((references as LSP.Location[]).map((l) => l.uri))
      expect(uris).toEqual(new Set([mainUri, libUri]))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
