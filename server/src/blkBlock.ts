import {
	DocumentSymbol, Position, Range, SymbolInformation, SymbolKind
} from 'vscode-languageserver'

export const extendsField = "_extends"
export const templateField = "_template"
export const overrideField = "_override"
export const importField = "import"
export const importSceneField = "scene"
export const groupBlock = "_group"

export const entityWithTemplateName = "entity"

export interface BlkPosition {
	offset: number
	line: number
	column: number
}

export class BlkPosition {
	static create(line = 1, column = 1, offset = 0): BlkPosition {
		return { offset: offset, line: line, column: column }
	}
	static toPosition(pos: BlkPosition) {
		return Position.create(pos.line - 1, pos.column - 1)
	}
	static less(a: BlkPosition, b: BlkPosition) {
		return a.line < b.line || (a.line == b.line && a.column < b.column)
	}
}

export interface BlkLocation {
	start: BlkPosition
	end: BlkPosition
}
export class BlkLocation {
	static clone(loc: BlkLocation): BlkLocation {
		return BlkLocation.create(loc.start, loc.end)
	}
	static create(start: BlkPosition = null, end: BlkPosition = null): BlkLocation {
		return {
			start: start ? BlkPosition.create(start.line, start.column, start.offset) : BlkPosition.create(),
			end: end ? BlkPosition.create(end.line, end.column, end.offset) : BlkPosition.create(),
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
	value: string[] // [name, type, value]

	_name: string // value?[0]
	_type: string // value?[1]
	_value: string // value?[2]
}

export class BlkParam {
	static toDocumentSymbol(param: BlkParam): DocumentSymbol {
		const range = BlkLocation.toRange(param.location)
		return {
			name: param._name,
			kind: SymbolKind.Field,
			range: range,
			selectionRange: range,
			detail: param._type && param._value ? `${param._type} = ${param._value}` : param._value ? param._value : param._type,
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

export function toSymbolInformation(name: string, location: BlkLocation, uri: string, kind: SymbolKind): SymbolInformation {
	return {
		name: name,
		kind: kind,
		location: { uri: uri, range: BlkLocation.toRange(location) }
	}
}

export class BlkBlock {
	static toDocumentSymbol(blk: BlkBlock): DocumentSymbol {
		const children = blk.params.map(it => BlkParam.toDocumentSymbol(it))
		const range = BlkLocation.toRange(blk.location)
		return {
			name: blk.name,
			kind: SymbolKind.Struct,
			range: range,
			selectionRange: range,
			children: children,
		}
	}
}
