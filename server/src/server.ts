import {
	createConnection, TextDocuments, ProposedFeatures, TextDocumentSyncKind, SymbolKind, SymbolInformation, Range, Position, DocumentSymbol, DidSaveTextDocumentNotification, MarkupKind, CompletionItem, CompletionItemKind, DidCloseTextDocumentNotification, Diagnostic, DiagnosticSeverity
} from 'vscode-languageserver'

import { parse } from './blk'
import { readdir, readFile, stat } from 'fs'
import { resolve, extname } from 'path'
import { URI } from 'vscode-uri'

interface BlkPosition {
	offset: number
	line: number
	column: number
}
class BlkPosition {
	static create(line = 0, column = 0, offset = 0): BlkPosition {
		return {
			offset: offset,
			line: line,
			column: column,
		}
	}
}
function toPosition(pos: BlkPosition) {
	return Position.create(pos.line - 1, pos.column - 1)
}

interface BlkLocation {
	start: BlkPosition
	end: BlkPosition
}
class BlkLocation {
	static create(start: BlkPosition = null, end: BlkPosition = null): BlkLocation {
		return {
			start: start ?? BlkPosition.create(),
			end: end ?? BlkPosition.create()
		}
	}
}
function toRange(loc: BlkLocation) {
	return Range.create(toPosition(loc.start), toPosition(loc.end))
}
function isPosInLocation(location: BlkLocation, position: { line: number, character: number }) {
	if (position.line < location.start.line - 1 ||
		(position.line == location.start.line - 1 && position.character < location.start.column - 1))
		return false
	if (position.line > location.end.line - 1 ||
		(position.line == location.end.line - 1 && position.character > location.end.column - 1))
		return false
	return true
}

interface BlkComment {
	indent: BlkLocation
	location: BlkLocation
	value: string
	format: 'line' | 'block'
}

interface BlkEmptyLine {
	location: BlkLocation
}

interface BlkIncludes {
	location: BlkLocation
	value: string
}

interface BlkParam {
	indent: BlkLocation
	location: BlkLocation
	value: string[]
}

interface BlkBlock {
	blocks: BlkBlock[]
	comments: BlkComment[]
	emptyLines: BlkEmptyLine[]
	includes: BlkIncludes[]
	location: BlkLocation
	name: string
	params: BlkParam[]
}

const namespacePostfix = ":_namespace\""
const extendsField = "_extends"

const connection = createConnection(ProposedFeatures.all)
const documents = new TextDocuments()

documents.listen(connection)


connection.onInitialize((params) => {
	params.workspaceFolders.forEach(it => addWorkspace(it.uri))
	connection.console.log(`blk-ecs started`)
	return {
		capabilities: {
			textDocumentSync: {
				openClose: true,
				change: TextDocumentSyncKind.Full
			},
			workspace: {
				workspaceFolders: {
					changeNotifications: true,
					supported: true
				}
			},
			documentSymbolProvider: true,
			workspaceSymbolProvider: true,
			definitionProvider: true,
			hoverProvider: true,
			referencesProvider: true,
			completionProvider: {
				resolveProvider: true,
			},
		}
	}
})

function blkToSymbolInformation(blk: BlkBlock, uri: string): SymbolInformation {
	return {
		name: blk.name,
		kind: SymbolKind.Struct,
		location: {
			uri: uri,
			range: toRange(blk.location)
		}
	}
}

function blkToDocumentSymbol(blk: BlkBlock): DocumentSymbol {
	const range = toRange(blk.location)
	return {
		name: blk.name,
		kind: SymbolKind.Struct,
		range: range,
		selectionRange: range,
		children: blk.params ? blk.params.map(it => paramToDocumentSymbol(it)) : null,
	}
}

function paramToDocumentSymbol(param: BlkParam): DocumentSymbol {
	const range = toRange(param.location)
	return {
		name: param.value[0],
		kind: SymbolKind.Field,
		range: range,
		selectionRange: range,
		detail: param.value.length > 2 ? param.value[2] : null,
	}
}

function purgeFile(fileUri: string) {
	const pathData = URI.parse(fileUri)
	fileContents.delete(pathData.fsPath)
	files.delete(pathData.fsPath)
	completionCacheInvalid = true
	completion.delete(pathData.fsPath)
}

connection.onInitialized(() => {
	connection.client.register(DidSaveTextDocumentNotification.type, undefined)
	connection.client.register(DidCloseTextDocumentNotification.type, undefined)
	// connection.client.register(DidChangeWorkspaceFoldersNotification.type, undefined)

	connection.workspace.onDidChangeWorkspaceFolders((event) => {
		event.added.forEach(it => addWorkspace(it.uri))
		event.removed.forEach(it => removeWorkspace(it.uri))
	})

	connection.onDidChangeTextDocument(params => {
		purgeFile(params.textDocument.uri)
		if (params.contentChanges.length > 0) {
			const pathData = URI.parse(params.textDocument.uri)
			fileContents.set(pathData.fsPath, params.contentChanges[0].text)
		}
		getOrScanFileUri(params.textDocument.uri)
	})

	connection.onDidOpenTextDocument(params => {
		purgeFile(params.textDocument.uri)
		getOrScanFileUri(params.textDocument.uri, true)
	})

	connection.onDidSaveTextDocument(params => {
		purgeFile(params.textDocument.uri)
		getOrScanFileUri(params.textDocument.uri, true)
	})

	connection.onDidCloseTextDocument(params => {
		purgeFile(params.textDocument.uri)
		connection.sendDiagnostics({
			uri: params.textDocument.uri,
			diagnostics: []
		})
		getOrScanFileUri(params.textDocument.uri)
	})

	connection.onWorkspaceSymbol(async (params) => {
		const res: SymbolInformation[] = []
		let limit = 300
		for (const [file, blkFile] of files) {
			for (const blk of blkFile?.blocks ?? [])
				if (blk.name.indexOf(params.query) != -1) {
					res.push(blkToSymbolInformation(blk, URI.file(file).toString()))
					limit--
					if (limit <= 0)
						return res
				}
		}
		return res
	})

	connection.onDocumentSymbol(async (params) => {
		const blkFile = await getOrScanFileUri(params.textDocument.uri)
		return blkFile?.blocks ? blkFile.blocks.map(blkToDocumentSymbol) : []
	})

	connection.onDefinition(async params => {
		const blkFile = await getOrScanFileUri(params.textDocument.uri)
		if (!blkFile)
			return null

		const res = onDefinition(blkFile, params.position)
		// if (res.error)
		// 	connection.sendNotification(ShowMessageNotification.type, {
		// 		type: MessageType.Error,
		// 		message: res.error
		// 	})
		if (res.error || res.res.length == 0)
			return null

		return res.res.map(it => {
			return {
				uri: URI.file(it.filePath).toString(),
				range: toRange(it.location),
			}
		})
	})

	connection.onHover(async params => {
		const blkFile = await getOrScanFileUri(params.textDocument.uri)
		if (!blkFile)
			return null

		const res = onDefinition(blkFile, params.position, /*only extends*/true)
		if (res.res.length == 0 && !res.error)
			return null

		const text = res.error
			? res.error
			: ("'" + res.name + "' is declared in:\n```\n" + res.res.map(it => `${it.filePath}:${it.location.start.line}`).join("\n") + "\n```")
		return {
			contents: {
				value: text,
				kind: MarkupKind.Markdown
			}
		}
	})

	connection.onReferences(async params => {
		const blkFile = await getOrScanFileUri(params.textDocument.uri)
		if (!blkFile)
			return null

		const pathData = URI.parse(params.textDocument.uri)
		const res = findAllReferencesAt(pathData.fsPath, blkFile, params.position)
		if (res.length == 0)
			return null

		return res.map(it => {
			return {
				uri: URI.file(it.filePath).toString(),
				range: toRange(it.location),
			}
		})
	})

	connection.onCompletion(() => {
		if (completionCacheInvalid) {
			completionCacheInvalid = false
			const completionCacheMap: Map<string, CompletionItem> = new Map()
			for (const file of completion.values())
				for (const it of file)
					completionCacheMap.set(it.label, it)
			completionCache = Array.from(completionCacheMap.values())
			completionCacheMap.clear()
		}
		return completionCache
	})

	connection.onCompletionResolve(params => params)
})

connection.listen()

const workspaces: Set<string> = new Set()
const fileContents: Map</*fsPath*/string, string> = new Map() // content of changed files
const files: Map</*fsPath*/string, BlkBlock> = new Map()
const completion: Map</*fsPath*/string, CompletionItem[]> = new Map()
let completionCacheInvalid = true
let completionCache: CompletionItem[] = []

function addWorkspace(workspaceUri: string): void {
	if (!workspaces.has(workspaceUri))
		workspaces.add(workspaceUri)

	scanWorkspace(workspaceUri)
}

function removeWorkspace(workspaceUri: string): void {
	workspaces.delete(workspaceUri)
}

function getOrScanFileUri(fileUri: string, diagnostic = false): Promise<BlkBlock> {
	const pathData = URI.parse(fileUri)
	if (files.has(pathData.fsPath))
		return Promise.resolve(files.get(pathData.fsPath))

	return scanFile(pathData.fsPath, null, diagnostic)
}

function addCompletion(filePath: string, name: string, kind: CompletionItemKind) {
	if ((name?.length ?? 0) == 0)
		return
	const item = { label: name, kind: kind }
	if (!completion.has(filePath))
		completion.set(filePath, [item])
	else
		completion.get(filePath).push(item)
}

function processFile(filePath: string, blkFile: BlkBlock) {
	if (!blkFile)
		return

	for (const blk of blkFile?.blocks ?? []) {
		if ((blk.blocks?.length ?? 0) > 0) {
			for (const child of blk.blocks) {
				if (child.name.endsWith(namespacePostfix)) {
					const prefix = child.name.substr(1, child.name.length - namespacePostfix.length - 1) + "."
					for (const childParam of child.params) {
						const newParam = {
							indent: childParam.indent,
							location: childParam.location,
							value: childParam.value.concat([]),
						}
						newParam.value[0] = prefix + newParam.value[0]
						blk.params = blk.params ?? []
						blk.params.push(newParam)
					}
				} else if (child.name.indexOf(":") != -1) {
					const parts = removeQuotes(child.name).split(":").map(it => it.trim())
					const newParam = {
						indent: BlkLocation.create(),
						location: child.location,
						value: parts,
					}
					blk.params = blk.params ?? []
					blk.params.push(newParam)
				}
			}
		}
		addCompletion(filePath, blk.name, CompletionItemKind.Struct)
		for (const param of blk?.params ?? []) {
			const len = param.value?.length ?? 0
			if (len > 1)
				addCompletion(filePath, `${param.value[0]}:${param.value[1]}`, CompletionItemKind.Field)
			else if (len > 0)
				addCompletion(filePath, param.value[0], CompletionItemKind.Field)
		}
	}
}


function validateFile(blkFile: BlkBlock, diagnostics: Diagnostic[]) {
	if (!blkFile)
		return

	for (const blk of blkFile?.blocks ?? []) {
		for (const param of blk?.params ?? []) {
			const len = param.value?.length ?? 0
			if (len > 2 && param.value[0] == extendsField && param.value[1] == "t") {
				const parents = getTemplates(removeQuotes(param.value[2]))
				if (parents.length == 0)
					diagnostics.push({
						message: `Unknown parent template '${param.value[2]}'`,
						range: toRange(param.location),
						severity: DiagnosticSeverity.Error,
					})
				else if (parents.length > 1)
					diagnostics.push({
						message: `Multiple templates '${param.value[2]}'`,
						range: toRange(param.location),
						severity: DiagnosticSeverity.Warning,
					})
			}
		}
	}
}

function scanFile(filePath: string, workspaceUri: string = null, diagnostic = false): Promise<BlkBlock> {
	return new Promise(done => {
		function onFile(err, data) {
			if (err != null) {
				connection.console.log(`read file '${filePath}' error:`)
				connection.console.log(err.message)
				return
			}
			const txt: string = data.toString()
			try {
				const blk: BlkBlock = parse(txt)
				processFile(filePath, blk)
				if (!workspaceUri || workspaces.has(workspaceUri))
					files.set(filePath, blk)
				if (diagnostic) {
					const diagnostics: Diagnostic[] = []
					validateFile(blk, diagnostics)
					connection.sendDiagnostics({
						uri: URI.file(filePath).toString(),
						diagnostics: diagnostics
					})
				}
				done(blk)
			} catch (err) {
				if (txt.trim().length > 0) {
					if (diagnostic) {
						const location: BlkLocation = <BlkLocation>err.location ?? BlkLocation.create()
						connection.sendDiagnostics({
							uri: URI.file(filePath).toString(),
							diagnostics: [
								{
									message: err.message,
									range: toRange(location)
								}
							]
						})
					}
					connection.console.log(`parse file '${filePath}' error:`)
					connection.console.log(err.message)
				}
				if (!workspaceUri || workspaces.has(workspaceUri))
					files.set(filePath, null)
				done(null)
			}
		}
		if (fileContents.has(filePath))
			onFile(null, fileContents.get(filePath))
		else
			readFile(filePath, onFile)
	})
}

function scanWorkspace(workspaceUri: string) {
	const pathData = URI.parse(workspaceUri)
	const path = pathData.fsPath
	connection.console.log(`scan workspace: ${path}`)
	walk(path, (err, file) => {
		if (err != null) {
			connection.console.log(`walk '${path}' error:`)
			connection.console.log(err.message)
			return
		}
		if (extname(file).toLowerCase() == ".blk")
			scanFile(file, workspaceUri)
	})
}

interface TemplatePos {
	filePath: string
	location: BlkLocation
}

function getTemplates(name: string): TemplatePos[] {
	const res: TemplatePos[] = []
	for (const [filePath, blkFile] of files)
		for (const blk of blkFile?.blocks ?? [])
			if (blk.name == name)
				res.push({ filePath: filePath, location: blk.location })
	return res
}

function removeQuotes(str: string): string {
	if (str.startsWith("\"") && str.endsWith("\""))
		return str.substr(1, str.length - 2)
	return str
}

function getParamAt(blkFile: BlkBlock, position: Position, depth = 0): { res: BlkParam, depth: number } {
	for (const blk of blkFile?.blocks ?? []) {
		if (isPosInLocation(blk.location, position))
			return getParamAt(blk, position, ++depth)
	}
	for (const param of blkFile?.params ?? []) {
		if (isPosInLocation(param.location, position))
			return { res: param, depth: depth }
	}
	return null
}

function onDefinition(blkFile: BlkBlock, position: Position, onlyExtends = false): { res: TemplatePos[], name?: string, error?: string } {
	const param = getParamAt(blkFile, position)
	if (param && param.res.value.length >= 3
		&& (!onlyExtends || (param.depth == 1 && param.res.value[0] == extendsField && param.res.value[1] == "t"))) {
		const name = removeQuotes(param.res.value[2])
		const res = getTemplates(name)
		if (res.length > 0)
			return { res: res, name: name }
		else
			return { res: [], error: `#undefined template '${name}'` }
	}
	return { res: [] }
}

function findAllReferences(name: string): TemplatePos[] {
	const longName = "\"" + name + "\""
	const res: TemplatePos[] = []
	for (const [filePath, blkFile] of files)
		for (const blk of blkFile?.blocks ?? [])
			for (const param of blk?.params ?? [])
				if ((param.value?.length ?? 0) > 2 && param.value[0] == extendsField && param.value[1] == "t" && (param.value[2] == name || param.value[2] == longName))
					res.push({ filePath: filePath, location: param.location })
	return res
}

function findAllTemplatesWithParam(name: string, type: string): TemplatePos[] {
	const res: TemplatePos[] = []
	for (const [filePath, blkFile] of files)
		for (const blk of blkFile?.blocks ?? [])
			for (const param of blk?.params ?? [])
				if ((param.value?.length ?? 0) > 1 && param.value[0] == name && param.value[1] == type)
					res.push({ filePath: filePath, location: param.location })
	return res
}

function findAllReferencesAt(filePath: string, blkFile: BlkBlock, position: Position): TemplatePos[] {
	for (const blk of blkFile?.blocks ?? []) {
		if (!blk.location || !isPosInLocation(blk.location, position))
			continue
		if (position.line == blk.location.start.line - 1) {
			const res = findAllReferences(blk.name)
			if (res.length > 0) {
				res.splice(0, 0, { filePath: filePath, location: blk.location })
				return res
			}
		}
		for (const param of blk?.params ?? []) {
			if ((param.value?.length ?? 0) < 2)
				continue
			if (!isPosInLocation(param.location, position))
				continue
			const res = findAllTemplatesWithParam(param.value[0], param.value[1])
			if (res.length > 0)
				return res
		}
	}
	return []
}

function walk(dir: string, iter: (err: NodeJS.ErrnoException, path: string) => void) {
	readdir(dir, function (err, list) {
		if (err) {
			iter(err, null)
			return
		}
		for (let file of list) {
			if (!file) continue
			file = resolve(dir, file)
			stat(file, function (err, stat) {
				if (err) {
					iter(err, null)
					return
				}
				if (stat && stat.isDirectory()) {
					walk(file, iter)
				} else {
					iter(null, file)
				}
			})
		}
	})
}