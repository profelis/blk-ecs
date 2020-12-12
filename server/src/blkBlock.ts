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
	static toPosition(pos: BlkPosition) {
		return Position.create(pos.line - 1, pos.column - 1)
	}
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
	static isPosInLocation(location: BlkLocation, position: Position) {
		if (position.line < location.start.line - 1 ||
			(position.line == location.start.line - 1 && position.character < location.start.column - 1))
			return false
		if (position.line > location.end.line - 1 ||
			(position.line == location.end.line - 1 && position.character > location.end.column - 1))
			return false
		return true
	}
	static toRange(loc: BlkLocation) { return Range.create(BlkPosition.toPosition(loc.start), BlkPosition.toPosition(loc.end)) }
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

export class BlkParam {
	static toDocumentSymbol(param: BlkParam): DocumentSymbol {
		const range = BlkLocation.toRange(param.location)
		return {
			name: param.value[0],
			kind: SymbolKind.Field,
			range: range,
			selectionRange: range,
			detail: param.value.length > 2 ? param.value[2] : null,
		}
	}
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

export class BlkBlock {
	static toSymbolInformation(blk: BlkBlock, uri: string): SymbolInformation {
		return {
			name: blk.name,
			kind: SymbolKind.Struct,
			location: {
				uri: uri,
				range: BlkLocation.toRange(blk.location)
			}
		}
	}
	static toDocumentSymbol(blk: BlkBlock): DocumentSymbol {
		const range = BlkLocation.toRange(blk.location)
		return {
			name: blk.name,
			kind: SymbolKind.Struct,
			range: range,
			selectionRange: range,
			children: blk.params ? blk.params.map(it => BlkParam.toDocumentSymbol(it)) : null,
		}
	}
}