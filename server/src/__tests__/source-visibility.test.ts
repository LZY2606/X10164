import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import * as LSP from 'vscode-languageserver/node'
import { TextDocument } from 'vscode-languageserver-textdocument'

import { getMockConnection } from '../../../testing/mocks'
import LspServer from '../server'

describe('source visibility protocol requests', () => {
  let root: string
  let server: LspServer
  let connection: ReturnType<typeof getMockConnection>
  let mainUri: string

  const handler = <T extends keyof typeof connection>(name: T) =>
    (connection[name] as jest.Mock).mock.calls[0][0] as (
      params: never,
      token?: unknown,
      workDoneProgress?: unknown,
    ) => Promise<unknown> | unknown

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'bash-source-visibility-'))
    cpSync(join(dirname(__filename), 'fixtures', 'source-visibility'), root, {
      recursive: true,
    })

    connection = getMockConnection()
    server = await LspServer.initialize(connection, {
      rootPath: pathToFileURL(root).href,
      rootUri: null,
      processId: 1,
      capabilities: {},
      workspaceFolders: null,
    })
    server.register(connection)
    const onInitialized = connection.onInitialized.mock.calls[0][0]
    await onInitialized({})

    mainUri = pathToFileURL(join(root, 'main.sh')).href
    openMainDocument()
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const openMainDocument = () => {
    const text = readFileSync(join(root, 'main.sh'), 'utf8')
    void server.analyzeAndLintDocument(
      TextDocument.create(mainUri, 'shellscript', 1, text),
    )
  }

  const nonEmptyEditUris = (edit: LSP.WorkspaceEdit) =>
    Object.entries(edit.changes ?? {})
      .filter(([, edits]) => edits.length > 0)
      .map(([uri]) => uri)
      .sort()

  const position = { line: 6, character: 9 }
  const textDocument = () => ({ uri: mainUri })

  it('uses the same visible symbol set for definition, references, completion and rename', async () => {
    const definition = handler('onDefinition')({
      textDocument: textDocument(),
      position,
    })
    const references = handler('onReferences')({
      textDocument: textDocument(),
      position,
      context: { includeDeclaration: true },
    })
    const completions = await handler('onCompletion')({
      textDocument: textDocument(),
      position: { line: 6, character: 9 },
    })
    const rename = await handler('onRenameRequest')({
      textDocument: textDocument(),
      position,
      newName: 'renamed',
    })

    expect(definition).toEqual([
      {
        uri: mainUri,
        range: {
          start: { line: 5, character: 8 },
          end: { line: 5, character: 13 },
        },
      },
    ])
    expect(references).toEqual([
      {
        uri: mainUri,
        range: {
          start: { line: 5, character: 8 },
          end: { line: 5, character: 13 },
        },
      },
      {
        uri: mainUri,
        range: {
          start: { line: 6, character: 9 },
          end: { line: 6, character: 14 },
        },
      },
    ])
    expect(
      (completions as LSP.CompletionItem[]).filter((item) => item.label === 'value'),
    ).toHaveLength(1)
    expect(rename).toEqual({
      changes: {
        [mainUri]: [
          {
            newText: 'renamed',
            range: {
              start: { line: 5, character: 8 },
              end: { line: 5, character: 13 },
            },
          },
          {
            newText: 'renamed',
            range: {
              start: { line: 6, character: 9 },
              end: { line: 6, character: 14 },
            },
          },
        ],
      },
    })
  })

  it('keeps a sourced global visible across linked files but excludes unrelated same-name symbols', async () => {
    const globalPosition = { line: 9, character: 3 }
    const definition = handler('onDefinition')({
      textDocument: textDocument(),
      position: globalPosition,
    })
    const references = handler('onReferences')({
      textDocument: textDocument(),
      position: globalPosition,
      context: { includeDeclaration: true },
    })
    const rename = await handler('onRenameRequest')({
      textDocument: textDocument(),
      position: globalPosition,
      newName: 'renamed_func',
    })

    expect(definition).toEqual([
      {
        uri: pathToFileURL(join(root, 'lib.sh')).href,
        range: {
          start: { line: 1, character: 0 },
          end: { line: 1, character: 11 },
        },
      },
    ])

    const referenceUris = (references as LSP.Location[]).map(({ uri }) => uri).sort()
    expect(referenceUris).toEqual(
      [mainUri, pathToFileURL(join(root, 'lib.sh')).href].sort(),
    )
    expect(referenceUris).not.toContain(pathToFileURL(join(root, 'unrelated.sh')).href)
    expect(nonEmptyEditUris(rename as LSP.WorkspaceEdit)).toEqual(referenceUris)
  })

  it('indexes the same sourced file once when reached through different relative paths', async () => {
    const lib2Uri = pathToFileURL(join(root, 'lib2.sh')).href
    const lib2Position = { line: 12, character: 8 }

    const definition = handler('onDefinition')({
      textDocument: textDocument(),
      position: lib2Position,
    })
    const references = handler('onReferences')({
      textDocument: textDocument(),
      position: lib2Position,
      context: { includeDeclaration: true },
    })
    const rename = await handler('onRenameRequest')({
      textDocument: textDocument(),
      position: lib2Position,
      newName: 'renamed_lib2_value',
    })

    expect(definition).toEqual([
      {
        uri: lib2Uri,
        range: {
          start: { line: 1, character: 0 },
          end: { line: 1, character: 10 },
        },
      },
    ])
    expect(new Set((references as LSP.Location[]).map(({ uri }) => uri))).toEqual(
      new Set([lib2Uri, mainUri]),
    )
    expect(nonEmptyEditUris(rename as LSP.WorkspaceEdit)).toEqual(
      [lib2Uri, mainUri].sort(),
    )
  })

  it('indexes a source cycle once', async () => {
    writeFileSync(join(root, 'cycle-a.sh'), 'source ./cycle-b.sh\ncycle_value=1\n')
    writeFileSync(join(root, 'cycle-b.sh'), 'source ./cycle-a.sh\n')
    writeFileSync(join(root, 'main.sh'), 'source ./cycle-a.sh\necho "$cycle_value"\n')
    openMainDocument()

    const cyclePosition = { line: 1, character: 8 }
    const definition = handler('onDefinition')({
      textDocument: textDocument(),
      position: cyclePosition,
    })
    const references = handler('onReferences')({
      textDocument: textDocument(),
      position: cyclePosition,
      context: { includeDeclaration: true },
    })
    const rename = await handler('onRenameRequest')({
      textDocument: textDocument(),
      position: cyclePosition,
      newName: 'cycled_value',
    })

    expect(definition).toEqual([
      {
        uri: pathToFileURL(join(root, 'cycle-a.sh')).href,
        range: {
          start: { line: 1, character: 0 },
          end: { line: 1, character: 11 },
        },
      },
    ])

    const uris = (references as LSP.Location[]).map(({ uri }) => uri)
    expect(uris).toEqual([pathToFileURL(join(root, 'cycle-a.sh')).href, mainUri])
    expect(nonEmptyEditUris(rename as LSP.WorkspaceEdit)).toEqual(
      [...new Set(uris)].sort(),
    )
  })

  it('refreshes on-demand sourced-file analysis after the file is edited on disk', async () => {
    writeFileSync(join(root, 'main.sh'), 'source ./lib.sh\nshared_func\n')
    openMainDocument()
    const editedLibrary = 'shared_func() {\n  echo edited\n}\n'
    const future = new Date(Date.now() + 10000)
    writeFileSync(join(root, 'lib.sh'), editedLibrary)
    utimesSync(join(root, 'lib.sh'), future, future)

    const references = handler('onReferences')({
      textDocument: textDocument(),
      position: { line: 1, character: 2 },
      context: { includeDeclaration: true },
    })

    expect((references as LSP.Location[]).map(({ range }) => range.start.line)).toEqual([
      0, 1,
    ])
  })

  it('returns conservative document-only results for a source path that is not statically resolvable', async () => {
    mkdirSync(join(root, 'env-target'), { recursive: true })
    writeFileSync(join(root, 'env-target', 'lib.sh'), 'dynamic_value=unsafe\n')
    writeFileSync(
      join(root, 'main.sh'),
      'source "$UNTRUSTED_DIR/lib.sh"\necho "$dynamic_value"\n',
    )
    openMainDocument()
    process.env.UNTRUSTED_DIR = join(root, 'env-target')

    try {
      const dynamicPosition = { line: 1, character: 7 }
      const dynamicReferences = handler('onReferences')({
        textDocument: textDocument(),
        position: dynamicPosition,
        context: { includeDeclaration: true },
      })
      const dynamicDefinition = handler('onDefinition')({
        textDocument: textDocument(),
        position: dynamicPosition,
      })
      const dynamicCompletions = await handler('onCompletion')({
        textDocument: textDocument(),
        position: { line: 1, character: 15 },
      })
      const dynamicRename = await handler('onRenameRequest')({
        textDocument: textDocument(),
        position: dynamicPosition,
        newName: 'safe_value',
      })

      expect(dynamicDefinition).toEqual([])
      expect(dynamicReferences).toEqual([
        {
          uri: mainUri,
          range: {
            start: { line: 1, character: 7 },
            end: { line: 1, character: 20 },
          },
        },
      ])
      expect(
        (dynamicCompletions as LSP.CompletionItem[]).some(
          (item) => item.label === 'dynamic_value',
        ),
      ).toBe(false)
      expect(Object.keys((dynamicRename as LSP.WorkspaceEdit).changes ?? {})).toEqual([
        mainUri,
      ])
    } finally {
      delete process.env.UNTRUSTED_DIR
    }
  })
})
