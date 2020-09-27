import {
	createConnection, TextDocuments, ProposedFeatures, TextDocumentSyncKind, SymbolKind, SymbolInformation, Range, Position, DocumentSymbol, DidSaveTextDocumentNotification, MarkupKind, ShowMessageNotification, MessageType
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
function toPosition(pos: BlkPosition) {
	return Position.create(pos.line - 1, pos.column - 1)
}

interface BlkLocation {
	start: BlkPosition
	end: BlkPosition
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

const connection = createConnection(ProposedFeatures.all)
const documents = new TextDocuments()

documents.listen(connection)


connection.onInitialize((params) => {
	params.workspaceFolders.forEach(it => addWorkspace(it.uri))
	connection.console.log(`[Server(${process.pid})] Started and initialize received`)
	return {
		capabilities: {
			textDocumentSync: {
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
			referencesProvider: true
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
		children: blk.params ? blk.params.map(it => paramToDocumentSymbol(it)) : null
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

connection.onInitialized(() => {
	connection.client.register(DidSaveTextDocumentNotification.type, undefined)
	// connection.client.register(DidChangeWorkspaceFoldersNotification.type, undefined)

	connection.workspace.onDidChangeWorkspaceFolders((event) => {
		event.added.forEach(it => addWorkspace(it.uri))
		event.removed.forEach(it => removeWorkspace(it.uri))
	})

	connection.onDidChangeTextDocument(params => {
		const pathData = URI.parse(params.textDocument.uri)
		if (params.contentChanges.length > 0)
			fileContents.set(pathData.fsPath, params.contentChanges[0].text)
		files.delete(pathData.fsPath)
	})

	connection.onDidSaveTextDocument(params => {
		const pathData = URI.parse(params.textDocument.uri)
		fileContents.delete(pathData.fsPath)
	})

	connection.onWorkspaceSymbol((params) => {
		const res: SymbolInformation[] = []
		for (const [file, blkFile] of files) {
			for (const blk of blkFile?.blocks ?? [])
				if (blk.name.indexOf(params.query) != -1)
					res.push(blkToSymbolInformation(blk, URI.file(file).toString()))
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

		const res = getTemplateUnderPos(blkFile, params.position)
		if (res.error)
			connection.sendNotification(ShowMessageNotification.type, {
				type: MessageType.Error,
				message: res.error
			})
		if (!res || res.error || res.res.length == 0)
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

		const res = getTemplateUnderPos(blkFile, params.position)
		if (!res || (res.res.length == 0 && !res.error))
			return null

		const text = res.error ? res.error : "Declared in:\n```\n" + res.res.map(it => it.filePath).join("\n") + "\n```"
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
		if (!res || res.length == 0)
			return null

		return res.map(it => {
			return {
				uri: URI.file(it.filePath).toString(),
				range: toRange(it.location),
			}
		})
	})
})

connection.listen()

const workspaces: Set<string> = new Set()
// content of changed files
const fileContents: Map<string, string> = new Map()
const files: Map<string, BlkBlock> = new Map()

function addWorkspace(workspaceUri: string): void {
	if (!workspaces.has(workspaceUri))
		workspaces.add(workspaceUri)

	scanWorkspace(workspaceUri)
}

function removeWorkspace(workspaceUri: string): void {
	workspaces.delete(workspaceUri)
}

function getOrScanFileUri(fileUri: string): Promise<BlkBlock> {
	const pathData = URI.parse(fileUri)
	if (files.has(pathData.fsPath))
		return Promise.resolve(files.get(pathData.fsPath))

	return scanFile(pathData.fsPath)
}

function scanFile(filePath: string, workspaceUri: string = null): Promise<BlkBlock> {
	return new Promise(done => {
		function onFile(err, data) {
			if (err != null) {
				connection.console.log(`read file '${filePath}' error:`)
				connection.console.log(err.message)
				return
			}
			try {
				const blk: BlkBlock = parse(data.toString())
				if (!workspaceUri || workspaces.has(workspaceUri))
					files.set(filePath, blk)
				done(blk)
			} catch (err) {
				connection.console.log(`parse file '${filePath}' error:`)
				connection.console.log(err.message)
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

function getTemplate(name: string): TemplatePos[] {
	const res: TemplatePos[] = []
	for (const [filePath, blkFile] of files)
		for (const blk of blkFile?.blocks ?? [])
			if (blk.name == name)
				res.push({ filePath: filePath, location: blk.location })
	return res
}

function getTemplateUnderPos(blkFile: BlkBlock, position: Position): { res: TemplatePos[], error?: string } {
	let error = ""
	for (const blk of blkFile?.blocks ?? []) {
		for (const param of blk.params) {
			if (param.value.length < 3 || param.value[0] != "_extends")
				continue
			if (!isPosInLocation(param.location, position))
				continue
			let name = param.value[2]
			if (name.startsWith("\"") && name.endsWith("\""))
				name = name.substr(1, name.length - 2)
			const res = getTemplate(name)
			if (res.length > 0)
				return { res: res }
			else
				error = `#undefined template '${name}'`
		}
	}
	return { res: [], error: error.length > 0 ? error : null }
}

function findAllReferences(name: string): TemplatePos[] {
	const longName = "\"" + name + "\""
	const res: TemplatePos[] = []
	for (const [filePath, blkFile] of files)
		for (const blk of blkFile?.blocks ?? [])
			for (const param of blk.params)
				if ((param.value?.length ?? 0) > 2 && param.value[0] == "_extends" && (param.value[2] == name || param.value[2] == longName))
					res.push({ filePath: filePath, location: param.location })
	return res
}

function findAllReferencesAt(filePath: string, blkFile: BlkBlock, position: Position): TemplatePos[] {
	for (const blk of blkFile?.blocks ?? []) {
		if (!isPosInLocation(blk.location, position) || position.line != blk.location.start.line - 1)
			continue
		const res = findAllReferences(blk.name)
		if (res.length > 0) {
			res.splice(0, 0, { filePath: filePath, location: blk.location })
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