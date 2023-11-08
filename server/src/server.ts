import {
	createConnection, ProposedFeatures, TextDocumentSyncKind, SymbolInformation, Position, DidSaveTextDocumentNotification, MarkupKind, CompletionItem, CompletionItemKind, DidCloseTextDocumentNotification, Diagnostic, DiagnosticSeverity, DidChangeWorkspaceFoldersNotification, CodeLens, SymbolKind, WorkspaceEdit
} from 'vscode-languageserver'

import { parse } from './blk'
import { readFile } from 'fs'
import { extname, dirname } from 'path'
import { URI } from 'vscode-uri'
import { extractAsPromised } from 'fuzzball'
import { findFile, walk } from './fsUtils'
import { BlkBlock, BlkParam, BlkPosition, BlkLocation, BlkIncludes, toSymbolInformation, entityWithTemplateName, templateField, extendsField, overrideField, importField, groupBlock, importSceneField } from './blkBlock'

const connection = createConnection(ProposedFeatures.all)

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
			codeLensProvider: {
				resolveProvider: true,
			},
			renameProvider: {
				prepareProvider: true,
			}
		}
	}
})


function purgeFile(fsPath: string) {
	fileContents.delete(fsPath)
	files.delete(fsPath)
	usagesInvalid = true
	extendsInFiles.delete(fsPath)
	entitiesInScenes.delete(fsPath)
	templatesInFiles.delete(fsPath)
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
		if (params.contentChanges.length > 0)
			fileContents.set(fsPath, params.contentChanges[0].text)
		scanFile(fsPath, null, false, true)
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
		const data: Array<{ file: string; location: BlkLocation, name: string, kind: SymbolKind }> = []
		const usedParams = new Set<string>()
		for (const [file, blkFile] of files)
			for (const blk of blkFile?.blocks ?? []) {
				const key = blk.name
				if (blk.name != entityWithTemplateName && !usedParams.has(key)) {
					data.push({ file: file, name: key, location: blk.location, kind: SymbolKind.Struct })
					usedParams.add(key)
				}
				for (const param of blk.params) {
					const key = param._name
					if (!usedParams.has(key)) {
						data.push({ file: file, name: key, location: param.location, kind: SymbolKind.Field })
						usedParams.add(key)
					}
				}
			}

		const scores = await extractAsPromised(params.query, data, { processor: (it) => it.name, limit: 100, cutoff: 20 })
		const res: SymbolInformation[] = []
		for (const [it] of scores)
			res.push(toSymbolInformation(it.name, it.location, URI.file(it.file).toString(), it.kind))
		return res
	})

	connection.onDocumentSymbol(async (params) => {
		const blkFile = await getOrScanFileUri(params.textDocument.uri)
		if (!blkFile)
			return null
		return blkFile.blocks.map(BlkBlock.toDocumentSymbol)
	})

	connection.onDefinition(async params => {
		const blkFile = await getOrScanFileUri(params.textDocument.uri)
		if (!blkFile)
			return null

		const res = onDefinition(params.textDocument.uri, blkFile, params.position)
		if (res.error || (res.res?.length ?? 0) == 0)
			return null

		return res.res.map(it => {
			return { uri: URI.file(it.filePath).toString(), range: BlkLocation.toRange(it.location) }
		})
	})

	connection.onHover(async params => {
		const blkFile = await getOrScanFileUri(params.textDocument.uri)
		if (!blkFile)
			return null

		const res = onDefinition(params.textDocument.uri, blkFile, params.position, /*only extends*/true)
		if ((res.res?.length ?? 0) == 0 && !res.error)
			return null

		const text = res.error
			? res.error
			: res?.include
				? ("```\n" + res.res.map(it => `${it.filePath}`).join("\n") + "\n```")
				: ("'" + res.name + "' is declared in:\n```\n" + res.res.map(it => `${it.filePath}:${it.location.start.line}`).join("\n") + "\n```")
		return {
			contents: { value: text, kind: MarkupKind.Markdown }
		}
	})

	connection.onReferences(async params => {
		const blkFile = await getOrScanFileUri(params.textDocument.uri)
		if (!blkFile)
			return null

		const pathData = URI.parse(params.textDocument.uri)
		const res = findAllReferencesAt(pathData.fsPath, blkFile, params.position)
		return res.length == 0 ? null : res.map(it => {
			return {
				uri: URI.file(it.filePath).toString(),
				range: BlkLocation.toRange(it.location),
			}
		})
	})

	connection.onCompletion(() => {
		if (completionCacheInvalid) {
			const start = Date.now()
			completionCacheInvalid = false
			const completionCacheMap: Map<string, CompletionItem> = new Map()
			for (const file of completion.values())
				for (const it of file)
					if (!completionCacheMap.has(it.label))
						completionCacheMap.set(it.label, it)
			completionCache = Array.from(completionCacheMap.values())
			completionCacheMap.clear()
			connection.console.log(`invalidate completion cache: ${completionCache.length} records from ${completion.size} files in ${Date.now() - start}ms`)
		}
		connection.console.log(`completion: ${completionCache.length} records in ${completion.size} files`)
		return completionCache
	})

	connection.onCompletionResolve(params => params)

	connection.onCodeLens(async params => {
		const blkFile = await getOrScanFileUri(params.textDocument.uri)
		if (!blkFile)
			return null

		if (usagesInvalid) {
			usagesMap.clear()
			usagesInvalid = false

			for (const fileMap of extendsInFiles.values())
				for (const [key, value] of fileMap)
					usagesMap.set(key, (usagesMap.has(key) ? usagesMap.get(key) : 0) + value)

			for (const fileMap of entitiesInScenes.values())
				for (const [key, value] of fileMap)
					usagesMap.set(key, (usagesMap.has(key) ? usagesMap.get(key) : 0) + value)

			for (const fileMap of templatesInFiles.values())
				for (const [key, value] of fileMap)
					usagesMap.set(key, (usagesMap.has(key) ? usagesMap.get(key) : 0) + value)
		}

		const res: CodeLens[] = []
		for (const blk of blkFile.blocks) {
			const name = removeQuotes(blk.name)
			if (usagesMap.has(name)) {
				const count = usagesMap.get(name)
				res.push({ range: BlkLocation.toRange(blk.location), command: { title: `${count} usage${count == 1 ? "" : "s"}`, command: null } })
			}
		}
		return res
	})

	connection.onCodeLensResolve(params => params)

	connection.onRenameRequest(async params => {
		const blkFile = await getOrScanFileUri(params.textDocument.uri)
		if (!blkFile)
			return null

		const pathData = URI.parse(params.textDocument.uri)
		const res = findAllReferencesAt(pathData.fsPath, blkFile, params.position)
		if (res.length == 0)
			return null

		const edit: WorkspaceEdit = { changes: {} }
		for (const data of res) {
			const uri = URI.file(data.filePath).toString()
			if (!(uri in edit.changes))
				edit.changes[uri] = []
			const range = BlkLocation.toRange(data.location)
			range.end.line = range.start.line
			if (data.indent)
				range.start.character = data.indent.end.column - 1
			if (data.name.startsWith("\""))
				range.start.character++
			// let endOffset = 0
			// if (data.prefix) {
			// 	const ns = data.name.endsWith(namespacePostfix) ? data.name.substr(1, data.name.length - namespacePostfix.length - 1) : data.name
			// 	endOffset = ns.length
			// }
			// else {
			// 	let nsLen = data.shortName != null ? 0 : namespace(data.name).length
			// 	if (nsLen > 0)
			// 		nsLen++
			// 	range.start.character += nsLen
			// 	endOffset = data.name.length - nsLen
			// }
			range.end.character = range.start.character + data.name.length
			edit.changes[uri].push({ range: range, newText: params.newName })
		}
		return edit
	})

	connection.onPrepareRename(async params => {
		const blkFile = await getOrScanFileUri(params.textDocument.uri)
		if (!blkFile)
			return null

		for (const blk of blkFile.blocks) {
			for (const param of blk.params)
				if (BlkLocation.isPosInLocation(param.location, params.position)) {
					return { range: BlkLocation.toRange(param.location), placeholder: param._name }
				}
			// for (const child of blk.blocks)
			// 	if (BlkLocation.isPosInLocation(child.location, params.position)) {
			// 		return { range: BlkLocation.toRange(child.location), placeholder: child.name }
			// 	}
			if (BlkLocation.isPosInLocation(blk.location, params.position))
				return null
		}
		return null
	})
})

connection.listen()

const workspaces: Set</*fsPath*/string> = new Set()
const openFiles: Set</*fsPath*/string> = new Set()
const fileContents: Map</*fsPath*/string, string> = new Map() // content of changed files
const files: Map</*fsPath*/string, BlkBlock> = new Map()

const extendsInFiles: Map</*fsPath*/string, Map</*template*/string, number>> = new Map()
const entitiesInScenes: Map</*fsPath*/string, Map</*template*/string, number>> = new Map()
const templatesInFiles: Map</*fsPath*/string, Map</*template*/string, number>> = new Map()
let usagesInvalid = true
const usagesMap: Map<string, number> = new Map()

const completion: Map</*fsPath*/string, CompletionItem[]> = new Map()
let completionCacheInvalid = true
let completionCache: CompletionItem[] = []

function rescanOpenFiles() {
	connection.console.log("> rescan open files")
	for (const fsPath of openFiles.values())
		scanFile(fsPath, null, true)
	usagesInvalid = true
}

function addWorkspaceUri(workspaceUri: string): void {
	const fsPath = URI.parse(workspaceUri).fsPath
	// connection.window.showInformationMessage(`'${fsPath}' scanning...`)
	connection.console.log(`> register workspace ${fsPath}`)
	if (!workspaces.has(fsPath))
		workspaces.add(fsPath)

	scanWorkspace(fsPath).finally(() => {
		connection.console.log(`Total files: ${files.size}`)
		rescanOpenFiles()
		// connection.window.showInformationMessage(`'${fsPath}' scan complete`)
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
			if (isFileInWorkspaces(fsPath))
				removeFiles.push(fsPath)
		for (const fsPath of removeFiles) {
			connection.console.log(`> unregister file ${fsPath}`)
			purgeFile(fsPath)
		}
	}
	rescanOpenFiles()
}

function getOrScanFileUri(fileUri: string): Promise<BlkBlock> { return getOrScanFile(URI.parse(fileUri).fsPath) }

function getOrScanFile(filePath: string, diagnostic = false): Promise<BlkBlock> {
	return files.has(filePath) ? Promise.resolve(files.get(filePath)) : scanFile(filePath, null, diagnostic)
}

function addCompletion(filePath: string, name: string, type: string, kind: CompletionItemKind) {
	if ((name?.length ?? 0) == 0)
		return
	completionCacheInvalid = true
	const item = { label: (type?.length ?? 0) == 0 ? name : `${name}:${type}`, kind: kind }
	if (!completion.has(filePath)) completion.set(filePath, [item]); else completion.get(filePath).push(item)
}

function cleanupBlkBlock(blk: BlkBlock, depth: number) {
	if (!blk)
		return
	delete blk.comments
	delete blk.emptyLines
	blk.blocks = blk.blocks ?? []
	for (const it of blk.blocks)
		cleanupBlkBlock(it, depth + 1)
	blk.params = blk.params ?? []
	for (const it of blk.params)
		cleanupBlkParam(it, depth)
}

function cleanupBlkParam(param: BlkParam, depth: number) {
	param._name = param.value.length > 0 ? removeQuotes(param.value[0]) : ""
	param._type = param.value.length > 1 ? param.value[1] : ""
	param._value = param.value.length > 2 ? param.value[2] : ""
	if (param.value.length > 0 && param.value[0].startsWith(`"`)) {
		param.indent.end.column++
		param.indent.end.offset++
	}
	delete param.value
}

function processFile(fsPath: string, blkFile: BlkBlock) {
	if (!blkFile)
		return

	cleanupBlkBlock(blkFile, 0)
	completionCacheInvalid = true
	completion.delete(fsPath)
	usagesInvalid = true
	extendsInFiles.delete(fsPath)
	entitiesInScenes.delete(fsPath)
	templatesInFiles.delete(fsPath)

	const extendsInFile: Map<string, number> = new Map()
	const entitiesInScene: Map<string, number> = new Map()
	const templatesInFile: Map<string, number> = new Map()

	for (let i = 0; i < blkFile.blocks.length; i++)
		for (let j = i + 1; j < blkFile.blocks.length; j++) {
			const name = blkFile.blocks[i].name
			if (name != entityWithTemplateName && name == blkFile.blocks[j].name)
				templatesInFile.set(name, (templatesInFile.get(name) ?? 0) + 1)
		}
	for (const blk of blkFile.blocks) {
		for (const child of blk.blocks) {
			if (child.name == groupBlock) {
				for (const childParam of child.params) {
					const newParam: BlkParam = {
						indent: BlkLocation.clone(childParam.indent),
						location: childParam.location,
						value: null,
						_name: childParam._name,
						_type: childParam._type,
						_value: childParam._value,
					}
					if (newParam._name.startsWith(`"`)) {
						newParam.indent.end.column++
						newParam.indent.end.offset++
					}
					blk.params.push(newParam)
					addCompletion(fsPath, newParam._name, newParam._type, CompletionItemKind.Field)
				}
				for (const childBlock of child.blocks) {
					const parts = removeQuotes(childBlock.name).split(":").map(it => it.trim())
					const newParam: BlkParam = {
						indent: BlkLocation.create(childBlock.location.start, childBlock.location.start),
						location: childBlock.location,
						value: null,
						_name: parts.length > 0 ? parts[0] : "",
						_type: parts.length > 1 ? parts[1] : "",
						_value: "",
					}
					if (childBlock.name.startsWith(`"`)) {
						newParam.indent.end.column++
						newParam.indent.end.offset++
					}
					blk.params.push(newParam)
					addCompletion(fsPath, newParam._name, newParam._type, CompletionItemKind.Field)
				}
			} else {
				const parts = removeQuotes(child.name).split(":").map(it => it.trim())
				const newParam: BlkParam = {
					indent: BlkLocation.create(child.location.start, child.location.start),
					location: child.location,
					value: null,
					_name: parts.length > 0 ? parts[0] : "",
					_type: parts.length > 1 ? parts[1] : "",
					_value: "",
				}
				if (child.name.startsWith(`"`)) {
					newParam.indent.end.column++
					newParam.indent.end.offset++
				}
				blk.params.push(newParam)
				addCompletion(fsPath, newParam._name, newParam._type, CompletionItemKind.Field)
			}
		}
		addCompletion(fsPath, blk.name, "", CompletionItemKind.Struct)

		for (const param of blk.params) {
			if (param._name == extendsField && param._type == "t" && param._value.length > 0) {
				const parentName = removeQuotes(param._value)
				extendsInFile.set(parentName, extendsInFile.has(parentName) ? extendsInFile.get(parentName) + 1 : 1)
			}
			addCompletion(fsPath, param._name, param._type, CompletionItemKind.Field)
		}

		if (blk.name == entityWithTemplateName)
			for (const param of blk.params)
				if (param._name == templateField && param._type == "t" && param._value.length > 0)
					for (const partName of splitAndRemoveQuotes(param._value))
						entitiesInScene.set(partName, entitiesInScene.has(partName) ? entitiesInScene.get(partName) + 1 : 1)
	}
	if (extendsInFile.size > 0)
		extendsInFiles.set(fsPath, extendsInFile)
	if (entitiesInScene.size > 0)
		entitiesInScenes.set(fsPath, entitiesInScene)
	if (templatesInFile.size > 0)
		templatesInFiles.set(fsPath, templatesInFile)
}


function validateFile(fsPath: string, blkFile: BlkBlock, diagnostics: Diagnostic[]) {
	connection.console.log(`> validate ${fsPath}`)
	if (!blkFile)
		return

	blkFile.blocks = blkFile.blocks ?? []
	for (const blk of blkFile.blocks) {
		if (blk.name == entityWithTemplateName)
			for (const param of blk.params)
				if (param._name == templateField && param._type == "t" && param._value.length > 0) {
					const parts = splitAndRemoveQuotes(param._value)
					for (const partName of parts)
						if (getTemplates(partName).length == 0)
							diagnostics.push({
								message: `Unknown template '${partName}'`,
								range: BlkLocation.toRange(param.location),
								severity: DiagnosticSeverity.Error,
							})
					const partsMap = new Map<string, boolean>()
					for (const partName of parts) {
						if (partsMap.has(partName))
							diagnostics.push({
								message: `Template duplicate '${partName}'`,
								range: BlkLocation.toRange(param.location),
								severity: DiagnosticSeverity.Error,
							})
						partsMap.set(partName, true)
					}
				}

		blk.params = blk.params ?? []
		for (const param of blk.params) {
			if (param._name == extendsField && param._type == "t" && param._value.length > 0) {
				const parentName = removeQuotes(param._value)
				if (parentName == blk.name)
					diagnostics.push({
						message: `Recursively dependency '${parentName}'`,
						range: BlkLocation.toRange(param.location),
						severity: DiagnosticSeverity.Error,
					})
				const parents = getTemplates(parentName)
				if (parents.length == 0)
					diagnostics.push({
						message: `Unknown parent template '${parentName}'`,
						range: BlkLocation.toRange(param.location),
						severity: DiagnosticSeverity.Error,
					})
				else if (parents.length > 1)
					diagnostics.push({
						message: `Multiple templates '${parentName}'`,
						range: BlkLocation.toRange(param.location),
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

function scanFile(fsPath: string, workspaceFsPath: string = null, diagnostic = false, lazy = false): Promise<BlkBlock> {
	return new Promise(done => {
		function onFile(err: NodeJS.ErrnoException, data: Buffer | string) {
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
							range: BlkLocation.toRange(location),
							severity: DiagnosticSeverity.Error,
						})
				}
				if (diagnostic)
					updateDiagnostics(fsPath, null, diagnostics)
				if (!lazy && (!workspaceFsPath || workspaces.has(workspaceFsPath)))
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
	name: string
	filePath: string
	location: BlkLocation
	indent?: BlkLocation
}

function getTemplates(name: string): TemplatePos[] {
	const res: TemplatePos[] = []
	for (const [filePath, blkFile] of files)
		for (const blk of blkFile?.blocks ?? [])
			if (blk.name == name)
				res.push({ name: blk.name, filePath: filePath, location: blk.location })
	return res
}

function splitAndRemoveQuotes(str: string, delemiter = "+"): string[] { return str.split(delemiter).map(removeQuotes) }

function removeQuotes(str: string): string {
	if (str.startsWith("\""))
		str = str.substr(1, str.length - 1)
	if (str.endsWith("\""))
		str = str.substr(0, str.length - 1)
	return str
}

function getParamAt(blkFile: BlkBlock, position: Position, depth = 0, parent: BlkBlock = null): { res: BlkParam, include: BlkIncludes, depth: number, parent?: BlkBlock } {
	for (const blk of blkFile.blocks) {
		if (BlkLocation.isPosInLocation(blk.location, position))
			return getParamAt(blk, position, ++depth, blk)
		for (const include of blk?.includes)
			if (BlkLocation.isPosInLocation(include.location, position))
				return { res: null, include: include, depth: depth, parent: parent }
	}
	for (const param of blkFile.params)
		if (BlkLocation.isPosInLocation(param.location, position))
			return { res: param, include: null, depth: depth, parent: parent }

	for (const include of blkFile.includes)
		if (BlkLocation.isPosInLocation(include.location, position))
			return { res: null, include: include, depth: depth, parent: parent }
	return null
}

function getRootBlock(blkFile: BlkBlock, loc: BlkLocation): BlkBlock {
	for (const blk of blkFile.blocks)
		if (BlkPosition.less(blk.location.start, loc.start) && BlkPosition.less(loc.end, blk.location.end))
			return blk
	return null
}

function onDefinition(uri: string, blkFile: BlkBlock, position: Position, onlyExtends = false): { res: TemplatePos[], name?: string, include?: string, error?: string } {
	const param = getParamAt(blkFile, position)
	if (!param)
		return { res: [] }
	// import:t=...
	if (param.depth == 0 && param.res && param.res._name == importField && param.res._type == "t" && (param.res._value?.length ?? 0) > 0) {
		const inc = removeQuotes(param.res._value)
		const paths = findWSFile(inc, dirname(URI.parse(uri).fsPath))
		return {
			include: inc,
			res: paths.map(it => { return { name: inc, filePath: it, location: BlkLocation.create() } }),
		}
	}
	// scene { import:t=... }
	if (param.res && param.res._name == importSceneField && param.res._type == "t" && param.parent && param.parent.name == importField) {
		const inc = removeQuotes(param.res._value)
		const paths = findWSFile(inc, dirname(URI.parse(uri).fsPath))
		return {
			include: inc,
			res: paths.map(it => { return { name: inc, filePath: it, location: BlkLocation.create() } }),
		}
	}
	// _override:b=
	if (param.depth == 1 && param.res && param.res._name == overrideField && param.res._type == "b") {
		const root = getRootBlock(blkFile, param.res.location)
		if (root) {
			const res = getTemplates(root.name)
			if (res.length > 0)
				return { res: res, name: root.name }
		}
	}
	// _extends:t=... -> _use:t=...
	if (param.res && (param.res._value?.length ?? 0) > 0 && (!onlyExtends || (param.res._name == extendsField && param.res._type == "t"))) {
		const startOffset = (param.res._name.length + param.res._type.length + param.res._value.length) - (param.res.location.end.column - 1 - position.character)
		let name = removeQuotes(param.res._value)
		if (startOffset > param.res._name.length) {
			if (name.indexOf("+") > 0) {
				const parts = param.res._value.split("+")
				let offset = param.res.location.end.column - 1 - position.character
				while (parts.length > 0) {
					const last = parts.pop()
					offset -= last.length
					if (offset <= 0) {
						name = removeQuotes(last)
						break
					}
					offset -= 1
				}
			}
			const res = getTemplates(name)
			if (res.length > 0)
				return { res: res, name: name }

			return { res: [], error: `#undefined template '${name}'` }
		}
		if (!onlyExtends) {
			name = param.res._name
			const nameRes = getTemplates(name)
			if (nameRes.length > 0)
				return { res: nameRes, name: param.res._name }

		}
		return { res: [], error: `#undefined template '${name}'` }
	}
	if (param.include) {
		const paths = findWSFile(param.include.value, dirname(URI.parse(uri).fsPath))
		return {
			include: param.include.value,
			res: paths.map(it => { return { name: param.include.value, filePath: it, location: BlkLocation.create() } }),
		}
	}
	return { res: [] }
}

function findWSFile(path: string, cwd: string): string[] {
	const relativePath = path.startsWith("#") || path.startsWith("%")
	path = relativePath ? path.substring(1) : path
	const res = findFile(path, cwd, workspaces.values(), relativePath, files.keys())
	if (res.length == 0 && relativePath) {
		let idx = path.replace(/\//g, "\\").indexOf("\\")
		if (idx >= 0)
			return findFile(path.substring(idx + 1), cwd, workspaces.values(), relativePath, files.keys())
	}
	return res
}

function findAllReferences(name: string): TemplatePos[] {
	const longName = `"${name}"`
	const res: TemplatePos[] = []
	for (const [filePath, blkFile] of files)
		for (const blk of blkFile?.blocks ?? []) {
			if (blk.name == entityWithTemplateName) {
				for (const param of blk.params)
					if (param._name == templateField && param._type == "t" && param._value.length > 0) {
						const parts = splitAndRemoveQuotes(param._value)
						for (const partName of parts) {
							if (partName == name) {
								res.push({ name: name, filePath: filePath, location: param.location, indent: param.indent })
								break
							}
						}
					}
			}
			else if (blk.name == name) {
				res.push({ name: name, filePath: filePath, location: blk.location })
			}
			for (const param of blk.params)
				if (param._name == extendsField && param._type == "t" && (param._value == name || param._value == longName))
					res.push({ name: name, filePath: filePath, location: param.location, indent: param.indent })

		}
	return res
}

function findAllTemplatesWithParam(name: string, type: string): TemplatePos[] {
	const res: TemplatePos[] = []
	for (const [filePath, blkFile] of files)
		for (const blk of blkFile?.blocks ?? []) {
			for (const param of blk.params)
				if (param._name == name && param._type == type)
					res.push({ name: name, filePath: filePath, location: param.location, indent: param.indent })
		}
	return res
}

function findAllReferencesAt(filePath: string, blkFile: BlkBlock, position: Position): TemplatePos[] {
	for (const blk of blkFile.blocks) {
		if (!blk.location || !BlkLocation.isPosInLocation(blk.location, position))
			continue
		if (position.line == blk.location.start.line - 1) {
			const res = findAllReferences(blk.name)
			if (res.length > 0) {
				res.splice(0, 0, { name: blk.name, filePath: filePath, location: blk.location })
				return res
			}
		}
		for (const param of blk.params) {
			if (!BlkLocation.isPosInLocation(param.location, position))
				continue
			const res = findAllTemplatesWithParam(param._name, param._type)
			if (res.length > 0)
				return res
		}
	}
	return []
}
