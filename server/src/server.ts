import {
	createConnection, ProposedFeatures, TextDocumentSyncKind, SymbolInformation, Position, DidSaveTextDocumentNotification, MarkupKind, CompletionItem, CompletionItemKind, DidCloseTextDocumentNotification, Diagnostic, DiagnosticSeverity, DidChangeWorkspaceFoldersNotification, CodeLens, SymbolKind, WorkspaceEdit
} from 'vscode-languageserver'

import { parse } from './blk'
import { readFile } from 'fs'
import { extname, dirname } from 'path'
import { URI } from 'vscode-uri'
import { extractAsPromised } from 'fuzzball'
import { findFile, walk } from './fsUtils'
import { BlkBlock, BlkParam, BlkPosition, BlkLocation, BlkIncludes, toSymbolInformation, namespacePostfix, entityWithTemplateName, templateField, extendsField, tail, namespace, overrideField, importField } from './blkBlock'

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

const DOT_FIX = "_dot_"
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
				data.push({ file: file, name: blk.name, location: blk.location, kind: SymbolKind.Struct })
				for (const param of blk?.params ?? [])
					if ((param?.value?.length ?? 0) > 1) {
						const key = param.value[0] + " : " + param.value[1]
						if (!usedParams.has(key)) {
							data.push({ file: file, name: key, location: param.location, kind: SymbolKind.Field })
							usedParams.add(key)
						}
					}
				for (const child of blk?.blocks ?? []) {
					if (child.name && child.name.indexOf(":") == -1 && !child.name.endsWith(namespacePostfix) && !usedParams.has(child.name)) {
						data.push({ file: file, name: child.name, location: child.location, kind: SymbolKind.Field })
						usedParams.add(child.name)
					}
				}
			}

		const replaceDot = params.query.indexOf(DOT_FIX) >= 0
		const query = replaceDot ? params.query.replace(DOT_FIX, ".") : params.query
		const scores = await extractAsPromised(query, data, { processor: (it) => it.name, limit: 100, cutoff: 20 })
		const res: SymbolInformation[] = []
		for (const [it] of scores) {
			const name = replaceDot ? it.name.replace(".", DOT_FIX) : it.name
			res.push(toSymbolInformation(name, it.location, URI.file(it.file).toString(), it.kind))
		}
		return res
	})

	connection.onDocumentSymbol(async (params) => {
		const blkFile = await getOrScanFileUri(params.textDocument.uri)
		return blkFile?.blocks ? blkFile.blocks.map(BlkBlock.toDocumentSymbol) : []
	})

	connection.onDefinition(async params => {
		const blkFile = await getOrScanFileUri(params.textDocument.uri)
		if (!blkFile)
			return null

		const res = onDefinition(params.textDocument.uri, blkFile, params.position)
		if (res.error || res.res.length == 0)
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
		if (res.res.length == 0 && !res.error)
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
		for (const blk of blkFile?.blocks ?? []) {
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
			if (data.prefix && data.shortName != null)
				continue
			const uri = URI.file(data.filePath).toString()
			if (!(uri in edit.changes))
				edit.changes[uri] = []
			const range = BlkLocation.toRange(data.location)
			range.end.line = range.start.line
			if (data.indent)
				range.start.character = data.indent.end.column - 1
			if (data.name.startsWith("\""))
				range.start.character++
			let endOffset = 0
			if (data.prefix) {
				const ns = data.name.endsWith(namespacePostfix) ? data.name.substr(1, data.name.length - namespacePostfix.length - 1) : data.name
				endOffset = ns.length
			}
			else {
				let nsLen = data.shortName != null ? 0 : namespace(data.name).length
				if (nsLen > 0)
					nsLen++
				range.start.character += nsLen
				endOffset = data.name.length - nsLen
			}
			range.end.character = range.start.character + endOffset
			edit.changes[uri].push({ range: range, newText: params.newName })
		}
		return edit
	})

	connection.onPrepareRename(async params => {
		const blkFile = await getOrScanFileUri(params.textDocument.uri)
		if (!blkFile)
			return null

		for (const blk of blkFile?.blocks ?? []) {
			for (const param of blk?.params ?? [])
				if (BlkLocation.isPosInLocation(param.location, params.position)) {
					const name = paramName(param, params.position)
					return { range: BlkLocation.toRange(param.location), placeholder: name.prefix ? name.name : tail(param.value[0]) }
				}
			for (const child of blk?.blocks ?? [])
				if (BlkLocation.isPosInLocation(child.location, params.position)) {
					const name = blockName(child, params.position)
					return { range: BlkLocation.toRange(child.location), placeholder: name.prefix ? name.name : tail(child.name) }
				}
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
	connection.window.showInformationMessage(`'${fsPath}' scanning...`)
	connection.console.log(`> register workspace ${fsPath}`)
	if (!workspaces.has(fsPath))
		workspaces.add(fsPath)

	scanWorkspace(fsPath).finally(() => {
		connection.console.log(`Total files: ${files.size}`)
		rescanOpenFiles()
		connection.window.showInformationMessage(`'${fsPath}' scan complete`)
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

function addCompletion(filePath: string, name: string, kind: CompletionItemKind) {
	if ((name?.length ?? 0) == 0)
		return
	completionCacheInvalid = true
	const item = { label: name, kind: kind }
	if (!completion.has(filePath)) completion.set(filePath, [item]); else completion.get(filePath).push(item)
}

function cleanupBlkBlock(blk: BlkBlock) {
	if (!blk)
		return
	blk.comments = null
	blk.emptyLines = null
	for (const it of blk?.blocks ?? [])
		cleanupBlkBlock(it)
}

function processFile(fsPath: string, blkFile: BlkBlock) {
	if (!blkFile)
		return

	cleanupBlkBlock(blkFile)
	completionCacheInvalid = true
	completion.delete(fsPath)
	usagesInvalid = true
	extendsInFiles.delete(fsPath)
	entitiesInScenes.delete(fsPath)
	templatesInFiles.delete(fsPath)

	const extendsInFile: Map<string, number> = new Map()
	const entitiesInScene: Map<string, number> = new Map()
	const templatesInFile: Map<string, number> = new Map()
	if (blkFile?.blocks)
		for (let i = 0; i < blkFile.blocks.length; i++)
			for (let j = i + 1; j < blkFile.blocks.length; j++) {
				const name = blkFile.blocks[i].name
				if (name != entityWithTemplateName && blkFile.blocks[i].name == blkFile.blocks[j].name)
					templatesInFile.set(blkFile.blocks[i].name, (templatesInFile.get(name) ?? 0) + 1)
			}
	for (const blk of blkFile?.blocks ?? []) {
		if ((blk.blocks?.length ?? 0) > 0) {
			for (const child of blk.blocks) {
				if (child.name.endsWith(namespacePostfix)) {
					const prefix = child.name.substr(1, child.name.length - namespacePostfix.length - 1) + "."
					for (const childParam of child.params) {
						const newParam: BlkParam = {
							indent: childParam.indent,
							location: childParam.location,
							value: childParam.value.concat([]),
							shortName: childParam.value[0]
						}
						newParam.value[0] = prefix + newParam.value[0]
						blk.params = blk.params ?? []
						blk.params.push(newParam)
					}
					for (const childBlock of child.blocks) {
						const parts = removeQuotes(childBlock.name).split(":").map(it => it.trim())
						const indent = BlkLocation.create(childBlock.location.start, childBlock.location.start)
						if (childBlock.name.startsWith("\"")) {
							indent.end.column++
							indent.end.offset++
						}
						const newParam: BlkParam = {
							indent: indent,
							location: childBlock.location,
							value: parts,
							shortName: parts[0],
						}
						newParam.value[0] = prefix + newParam.value[0]
						blk.params = blk.params ?? []
						blk.params.push(newParam)
					}
				} else if (child.name.indexOf(":") != -1) {
					const parts = removeQuotes(child.name).split(":").map(it => it.trim())
					const indent = BlkLocation.create(child.location.start, child.location.start)
					if (child.name.startsWith("\"")) {
						indent.end.column++
						indent.end.offset++
					}
					const newParam: BlkParam = {
						indent: indent,
						location: child.location,
						value: parts,
					}
					blk.params = blk.params ?? []
					blk.params.push(newParam)
				} else
					addCompletion(fsPath, child.name, CompletionItemKind.Field)
			}
		}
		addCompletion(fsPath, blk.name, CompletionItemKind.Struct)
		if (blk.name == entityWithTemplateName)
			for (const param of blk?.params ?? [])
				if ((param.value?.length ?? 0) > 2 && param.value[0] == templateField && param.value[1] == "t")
					for (const partName of splitAndRemoveQuotes(param.value[2]))
						entitiesInScene.set(partName, entitiesInScene.has(partName) ? entitiesInScene.get(partName) + 1 : 1)

		for (const param of blk?.params ?? []) {
			const len = param.value?.length ?? 0
			if (len > 2 && param.value[0] == extendsField && param.value[1] == "t") {
				const parentName = removeQuotes(param.value[2])
				extendsInFile.set(parentName, extendsInFile.has(parentName) ? extendsInFile.get(parentName) + 1 : 1)
			}
			if (len > 1)
				addCompletion(fsPath, `${param.value[0]}:${param.value[1]}`, CompletionItemKind.Field)
			else if (len > 0)
				addCompletion(fsPath, param.value[0], CompletionItemKind.Field)
		}
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

	for (const blk of blkFile?.blocks ?? []) {
		if (blk.name == entityWithTemplateName)
			for (const param of blk?.params ?? [])
				if ((param.value?.length ?? 0) > 2 && param.value[0] == templateField && param.value[1] == "t") {
					const parts = splitAndRemoveQuotes(param.value[2])
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

		for (const param of blk?.params ?? []) {
			const len = param.value?.length ?? 0
			if (len > 2 && param.value[0] == extendsField && param.value[1] == "t") {
				const parentName = removeQuotes(param.value[2])
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
	prefix?: boolean
	shortName?: string
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

function getParamAt(blkFile: BlkBlock, position: Position, depth = 0): { res: BlkParam, include: BlkIncludes, depth: number } {
	for (const blk of blkFile?.blocks ?? []) {
		if (BlkLocation.isPosInLocation(blk.location, position))
			return getParamAt(blk, position, ++depth)
		for (const include of blk?.includes)
			if (BlkLocation.isPosInLocation(include.location, position))
				return { res: null, include: include, depth: depth }
	}
	for (const param of blkFile?.params ?? [])
		if (BlkLocation.isPosInLocation(param.location, position))
			return { res: param, include: null, depth: depth }

	for (const include of blkFile?.includes)
		if (BlkLocation.isPosInLocation(include.location, position))
			return { res: null, include: include, depth: depth }
	return null
}

function getRootBlock(blkFile: BlkBlock, loc: BlkLocation): BlkBlock {
	for (const blk of blkFile?.blocks ?? [])
		if (BlkPosition.less(blk.location.start, loc.start) && BlkPosition.less(loc.end, blk.location.end))
			return blk
	return null
}

function onDefinition(uri: string, blkFile: BlkBlock, position: Position, onlyExtends = false): { res: TemplatePos[], name?: string, include?: string, error?: string } {
	const param = getParamAt(blkFile, position)
	if (!param)
		return { res: [] }
	if (param.depth == 0 && (param.res?.value?.length ?? 0) >= 3 && param.res?.value[0] == importField && param.res?.value[1] == "t") {
		const inc = removeQuotes(param.res.value[2])
		return {
			include: inc,
			res: [{ name: inc, filePath: findWSFile(inc, dirname(URI.parse(uri).fsPath)), location: BlkLocation.create(), prefix: false }],
		}
	}
	if (param.depth == 1 && (param.res?.value?.length ?? 0) >= 3 && param.res?.value[0] == overrideField && param.res?.value[1] == "b") {
		const root = getRootBlock(blkFile, param.res.location)
		if (root) {
			const res = getTemplates(root.name)
			if (res.length > 0)
				return { res: res, name: root.name }
		}
	}
	if ((param.res?.value?.length ?? 0) >= 3
		&& (!onlyExtends || (param.depth == 1 && param.res.value[0] == extendsField && param.res.value[1] == "t"))) {
		const startOffset = (param.res.value[0].length + param.res.value[1].length + param.res.value[2].length) - (param.res.location.end.column - 1 - position.character)
		let name = removeQuotes(param.res.value[2])
		if (startOffset > param.res.value[0].length) {
			if (name.indexOf("+") > 0) {
				const parts = param.res.value[2].split("+")
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
			name = param.res.value[0]
			const nameRes = getTemplates(name)
			if (nameRes.length > 0)
				return { res: nameRes, name: param.res.value[0] }

		}
		return { res: [], error: `#undefined template '${name}'` }
	}
	if (param.include)
		return {
			include: param.include.value,
			res: [{ name: param.include.value, filePath: findWSFile(param.include.value, dirname(URI.parse(uri).fsPath)), location: BlkLocation.create(), prefix: false }],
		}
	return { res: [] }
}

function findWSFile(path: string, cwd: string) {
	path = path.startsWith("#") ? path.substr(1) : path
	return findFile(path, cwd, Array.from(workspaces.values()))
}

function findAllReferences(name: string): TemplatePos[] {
	const longName = "\"" + name + "\""
	const res: TemplatePos[] = []
	for (const [filePath, blkFile] of files)
		for (const blk of blkFile?.blocks ?? []) {
			if (blk.name == entityWithTemplateName) {
				for (const param of blk?.params ?? [])
					if ((param.value?.length ?? 0) > 2 && param.value[0] == templateField && param.value[1] == "t") {
						const parts = splitAndRemoveQuotes(param.value[2])
						for (const partName of parts) {
							if (partName == name) {
								res.push({ name: param?.shortName ?? name, filePath: filePath, location: param.location, indent: param.indent, shortName: param.shortName })
								break
							}
						}
					}
			}
			else if (blk.name == name) {
				res.push({ name: name, filePath: filePath, location: blk.location })
			}
			for (const param of blk?.params ?? [])
				if ((param.value?.length ?? 0) > 2 && param.value[0] == extendsField && param.value[1] == "t" && (param.value[2] == name || param.value[2] == longName))
					res.push({ name: param?.shortName ?? name, filePath: filePath, location: param.location, indent: param.indent })

		}
	return res
}

function findAllTemplatesWithParam(name: string, type: string, prefix: boolean): TemplatePos[] {
	const nameWithDot = prefix ? name + "." : name
	const nameWithQuote = prefix ? '"' + name : name
	const res: TemplatePos[] = []
	for (const [filePath, blkFile] of files)
		for (const blk of blkFile?.blocks ?? []) {
			for (const param of blk?.params ?? [])
				if ((param.value?.length ?? 0) > 1 && ((prefix && param.value[0].startsWith(nameWithDot)) || (!prefix && param.value[0] == name && param.value[1] == type)))
					res.push({ name: param?.shortName ?? name, filePath: filePath, location: param.location, indent: param.indent, prefix: prefix, shortName: param.shortName })
			if (prefix || type.length == 0) {
				for (const block of blk?.blocks ?? [])
					if ((prefix && (block.name.startsWith(nameWithDot) || (block.name.startsWith(nameWithQuote) && block.name.endsWith(namespacePostfix)))) || (!prefix && block.name == name))
						res.push({ name: block.name, filePath: filePath, location: block.location, prefix: prefix })
			}
		}
	return res
}

interface NameAtPosData {
	name: string
	prefix?: boolean
	fullName: string
}

function paramName(param: BlkParam, position: Position): NameAtPosData {
	const name = param.value[0]
	if (param.shortName)
		return { name: name, fullName: name }
	const ns = namespace(name)
	if (ns.length > 0) {
		const offset = position.character - (param.indent ? param.indent.end.column : param.location.start.column) + 1
		if (offset <= ns.length)
			return { name: ns, fullName: name, prefix: true }
	}
	return { name: name, fullName: name }
}

function blockName(block: BlkBlock, position: Position): NameAtPosData {
	let name = block.name
	let prefix = false
	if (name.endsWith(namespacePostfix)) {
		name = name.substr(1, name.length - namespacePostfix.length - 1)
		prefix = true
	}
	const ns = namespace(name)
	if (ns.length > 0) {
		const offset = position.character - block.location.start.column + 1
		if (offset + (name.startsWith('"') ? 1 : 0) <= ns.length) {
			name = ns
			prefix = true
		}
	}
	return { name: name, fullName: block.name, prefix: prefix }
}

function findAllReferencesAt(filePath: string, blkFile: BlkBlock, position: Position): TemplatePos[] {
	for (const blk of blkFile?.blocks ?? []) {
		if (!blk.location || !BlkLocation.isPosInLocation(blk.location, position))
			continue
		if (position.line == blk.location.start.line - 1) {
			const res = findAllReferences(blk.name)
			if (res.length > 0) {
				res.splice(0, 0, { name: blk.name, filePath: filePath, location: blk.location })
				return res
			}
		}
		for (const param of blk?.params ?? []) {
			if ((param.value?.length ?? 0) < 2 || !BlkLocation.isPosInLocation(param.location, position))
				continue
			const name = paramName(param, position)
			const res = findAllTemplatesWithParam(name.prefix ? name.name : name.name, param.value[1], name.prefix ?? false)
			if (res.length > 0)
				return res
		}
		for (const block of blk?.blocks ?? []) {
			if (!block.location || !BlkLocation.isPosInLocation(block.location, position))
				continue
			const name = blockName(block, position)
			const res = findAllTemplatesWithParam(name.prefix ? name.name : name.name, "", name.prefix)
			if (res.length > 0)
				return res
		}
	}
	return []
}
