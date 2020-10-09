import {
	createConnection, TextDocuments, ProposedFeatures, TextDocumentSyncKind, SymbolKind, SymbolInformation, Range, Position, DocumentSymbol, DidSaveTextDocumentNotification, MarkupKind, CompletionItem, CompletionItemKind, DidCloseTextDocumentNotification, Diagnostic, DiagnosticSeverity, DidChangeWorkspaceFoldersNotification
} from 'vscode-languageserver'

import { parse } from './blk'
import { readdir, readFile, statSync } from 'fs'
import { resolve, extname } from 'path'
import { URI } from 'vscode-uri'
import { partial_ratio } from 'fuzzball'

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
	params.workspaceFolders.forEach(it => addWorkspaceUri(it.uri))
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

function purgeFile(fsPath: string) {
	fileContents.delete(fsPath)
	files.delete(fsPath)
	completionCacheInvalid = true
	completion.delete(fsPath)
}

connection.onInitialized(() => {
	connection.client.register(DidSaveTextDocumentNotification.type, undefined)
	connection.client.register(DidCloseTextDocumentNotification.type, undefined)
	connection.client.register(DidChangeWorkspaceFoldersNotification.type, undefined)

	connection.workspace.onDidChangeWorkspaceFolders((event) => {
		event.added.forEach(it => addWorkspaceUri(it.uri))
		event.removed.forEach(it => removeWorkspaceUri(it.uri))
	})

	connection.onDidChangeTextDocument(params => {
		const fsPath = URI.parse(params.textDocument.uri).fsPath
		purgeFile(fsPath)
		if (params.contentChanges.length > 0) {
			fileContents.set(fsPath, params.contentChanges[0].text)
		}
		getOrScanFile(fsPath)
	})

	connection.onDidOpenTextDocument(params => {
		const fsPath = URI.parse(params.textDocument.uri).fsPath
		purgeFile(fsPath)
		openFiles.add(fsPath)
		getOrScanFile(fsPath, true)
	})

	connection.onDidSaveTextDocument(params => {
		const fsPath = URI.parse(params.textDocument.uri).fsPath
		purgeFile(fsPath)
		getOrScanFile(fsPath, true)
	})

	connection.onDidCloseTextDocument(params => {
		const fsPath = URI.parse(params.textDocument.uri).fsPath
		purgeFile(fsPath)
		connection.sendDiagnostics({
			uri: params.textDocument.uri,
			diagnostics: []
		})
		openFiles.delete(fsPath)
		getOrScanFile(fsPath)
	})

	connection.onWorkspaceSymbol(async (params) => {
		const res: SymbolInformation[] = []
		let limit = 1000
		for (const [file, blkFile] of files) {
			for (const blk of blkFile?.blocks ?? [])
				if (partial_ratio(params.query, blk.name) > 0) {
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

const workspaces: Set</*fsPath*/string> = new Set()
const openFiles: Set</*fsPath*/string> = new Set()
const fileContents: Map</*fsPath*/string, string> = new Map() // content of changed files
const files: Map</*fsPath*/string, BlkBlock> = new Map()
const completion: Map</*fsPath*/string, CompletionItem[]> = new Map()
let completionCacheInvalid = true
let completionCache: CompletionItem[] = []

function rescanOpenFiles() {
	connection.console.log("> rescan open files")
	for (const fsPath of openFiles.values())
		scanFile(fsPath, null, true)
}

function addWorkspaceUri(workspaceUri: string): void {
	const fsPath = URI.parse(workspaceUri).fsPath
	connection.console.log(`> register workspace ${fsPath}`)
	if (!workspaces.has(fsPath))
		workspaces.add(fsPath)

	scanWorkspace(fsPath).finally(() => {
		connection.console.log(`Total files: ${files.size}`)
		rescanOpenFiles()
	})
}

function isFileInWorkspaces(fsPath: string) {
	for (const ws of workspaces.values())
		if (ws.startsWith(fsPath))
			return true
	return false
}

function removeWorkspaceUri(workspaceUri: string): void {
	const fsPath = URI.parse(workspaceUri).fsPath
	connection.console.log(`> unregister workspace ${fsPath}`)
	workspaces.delete(fsPath)

	if (workspaces.size == 0)
		files.clear()
	else {
		const removeFiles: string[] = []
		for (const fsPath of openFiles.keys())
			if (!isFileInWorkspaces(fsPath))
				removeFiles.push(fsPath)
		for (const fsPath of removeFiles) {
			connection.console.log(`> unregister file ${fsPath}`)
			files.delete(fsPath)
		}
	}
	rescanOpenFiles()
}

function getOrScanFileUri(fileUri: string, diagnostic = false): Promise<BlkBlock> {
	const pathData = URI.parse(fileUri)
	return getOrScanFile(pathData.fsPath)
}

function getOrScanFile(filePath: string, diagnostic = false): Promise<BlkBlock> {
	if (files.has(filePath))
		return Promise.resolve(files.get(filePath))

	return scanFile(filePath, null, diagnostic)
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


function validateFile(fsPath: string, blkFile: BlkBlock, diagnostics: Diagnostic[]) {
	connection.console.log(`> validate ${fsPath}`)
	if (!blkFile)
		return

	for (const blk of blkFile?.blocks ?? []) {
		for (const param of blk?.params ?? []) {
			const len = param.value?.length ?? 0
			if (len > 2 && param.value[0] == extendsField && param.value[1] == "t") {
				const parents = getTemplates(removeQuotes(param.value[2]))
				if (parents.length == 0)
					diagnostics.push({
						message: `Unknown parent template '${removeQuotes(param.value[2])}'`,
						range: toRange(param.location),
						severity: DiagnosticSeverity.Error,
					})
				else if (parents.length > 1)
					diagnostics.push({
						message: `Multiple templates '${removeQuotes(param.value[2])}'`,
						range: toRange(param.location),
						severity: DiagnosticSeverity.Hint,
					})
			}
		}
	}
}

function updateDiagnostics(fsPath: string, blk: BlkBlock, diagnostics: Diagnostic[] = []) {
	if (blk)
		validateFile(fsPath, blk, diagnostics)
	connection.sendDiagnostics({
		uri: URI.file(fsPath).toString(),
		diagnostics: diagnostics
	})
}

function scanFile(fsPath: string, workspaceFsPath: string = null, diagnostic = false): Promise<BlkBlock> {
	return new Promise(done => {
		function onFile(err, data) {
			if (err != null) {
				connection.console.log(`read file ${fsPath} error:`)
				connection.console.log(err.message)
				done(null)
				return
			}
			let txt: string = data.toString()
			if (txt.charCodeAt(0) == 0xFEFF)
				txt = txt.substr(1)
			try {
				const blk: BlkBlock = parse(txt)
				processFile(fsPath, blk)
				if (!workspaceFsPath || workspaces.has(workspaceFsPath))
					files.set(fsPath, blk)
				if (diagnostic)
					updateDiagnostics(fsPath, blk)
				done(blk)
			} catch (err) {
				const diagnostics: Diagnostic[] = []
				if (txt.trim().length > 0) {
					connection.console.log(`parse file ${fsPath} error:`)
					connection.console.log(err.message)
					const location: BlkLocation = <BlkLocation>err.location ?? BlkLocation.create()
					if (diagnostic)
						diagnostics.push({
							message: err.message,
							range: toRange(location),
							severity: DiagnosticSeverity.Error,
						})
				}
				if (diagnostic)
					updateDiagnostics(fsPath, null, diagnostics)
				if (!workspaceFsPath || workspaces.has(workspaceFsPath))
					files.set(fsPath, null)
				done(null)
			}
		}
		if (fileContents.has(fsPath))
			onFile(null, fileContents.get(fsPath))
		else
			readFile(fsPath, onFile)
	})
}

function scanWorkspace(fsPath: string): Promise<void> {
	connection.console.log(`scan workspace: ${fsPath}`)
	return walk(fsPath, (err, file) => {
		if (err != null) {
			connection.console.log(`walk ${file ?? fsPath} error:`)
			connection.console.log(err.message)
			return Promise.resolve()
		}
		if (extname(file).toLowerCase() == ".blk") {
			connection.console.log(`scan ${file}`)
			return new Promise<void>(done => scanFile(file, fsPath).finally(done))
		}
		return Promise.resolve()
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

function walk(dir: string, iter: (err: NodeJS.ErrnoException, path: string) => Promise<void>): Promise<void> {
	return new Promise<void>((done) =>
		readdir(dir, function (err, list) {
			if (err) {
				iter(err, dir).finally(done)
				return
			}
			const promises: Promise<void>[] = []
			for (let file of list) {
				if (!file) continue
				file = resolve(dir, file)
				const stat = statSync(file)
				if (stat && stat.isDirectory())
					promises.push(walk(file, iter))
				else
					promises.push(iter(null, file))
			}
			if (promises.length == 0)
				done()
			else
				Promise.all(promises).finally(done)
		})
	)
}