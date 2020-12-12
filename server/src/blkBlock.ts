
import {
	DocumentSymbol, Position, Range, SymbolInformation, SymbolKind
} from 'vscode-languageserver'

export interface BlkPosition {
	offset: number
	line: number
	column: number
}

export class BlkPosition {
	static create(line = 1, column = 1, offset = 0): BlkPosition {
		return {
			offset: offset,
			line: line,
			column: column,
		}
	}
}

export function toPosition(pos: BlkPosition) {
	return Position.create(pos.line - 1, pos.column - 1)
}

export interface BlkLocation {
	start: BlkPosition
	end: BlkPosition
}
export class BlkLocation {
	static create(start: BlkPosition = null, end: BlkPosition = null): BlkLocation {
		return {
			start: start ?? BlkPosition.create(),
			end: end ?? BlkPosition.create()
		}
	}
}

export function toRange(loc: BlkLocation) { return Range.create(toPosition(loc.start), toPosition(loc.end)) }

export function isPosInLocation(location: BlkLocation, position: { line: number, character: number }) {
	if (position.line < location.start.line - 1 ||
		(position.line == location.start.line - 1 && position.character < location.start.column - 1))
		return false
	if (position.line > location.end.line - 1 ||
		(position.line == location.end.line - 1 && position.character > location.end.column - 1))
		return false
	return true
}

export interface BlkComment {
	indent: BlkLocation
	location: BlkLocation
	value: string
	format: 'line' | 'block'
}

export interface BlkEmptyLine {
	location: BlkLocation
}

export interface BlkIncludes {
	location: BlkLocation
	value: string
}

export interface BlkParam {
	indent: BlkLocation
	location: BlkLocation
	value: string[]
}

export interface BlkBlock {
	blocks: BlkBlock[]
	comments: BlkComment[]
	emptyLines: BlkEmptyLine[]
	includes: BlkIncludes[]
	location: BlkLocation
	name: string
	params: BlkParam[]
}

export function blkToSymbolInformation(blk: BlkBlock, uri: string): SymbolInformation {
	return {
		name: blk.name,
		kind: SymbolKind.Struct,
		location: {
			uri: uri,
			range: toRange(blk.location)
		}
	}
}

export function blkToDocumentSymbol(blk: BlkBlock): DocumentSymbol {
	const range = toRange(blk.location)
	return {
		name: blk.name,
		kind: SymbolKind.Struct,
		range: range,
		selectionRange: range,
		children: blk.params ? blk.params.map(it => paramToDocumentSymbol(it)) : null,
	}
}

export function paramToDocumentSymbol(param: BlkParam): DocumentSymbol {
	const range = toRange(param.location)
	return {
		name: param.value[0],
		kind: SymbolKind.Field,
		range: range,
		selectionRange: range,
		detail: param.value.length > 2 ? param.value[2] : null,
	}
}