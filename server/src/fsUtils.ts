import { readdir, statSync, existsSync } from 'fs'
import { resolve, isAbsolute } from 'path'

export function walk(dir: string, iter: (err: NodeJS.ErrnoException, path: string) => Promise<void>): Promise<void> {
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
				promises.push(stat && stat.isDirectory() ? walk(file, iter) : iter(null, file))
			}
			if (promises.length == 0) done(); else Promise.all(promises).finally(done)
		})
	)
}

export function findFile(path: string, cwd: string, folders: IterableIterator<string>, relativePath: boolean, openFiles: IterableIterator<string>): string[] {
	path = (path || "").trim()
	if (path.length == 0 || isAbsolute(path))
		return [path]

	const res = resolve(cwd, path)
	if ((path.startsWith(".") && !path.startsWith("..")) || existsSync(res))
		return [res]

	for (const it of folders) {
		const res = resolve(it, path)
		if (existsSync(res))
			return [res]
	}
	if (!relativePath && path.indexOf("/") == -1 && path.indexOf("\\") == -1)
		return [path]

	let paths = new Array<string>()
	for (const openPath of openFiles) {
		if (openPath.indexOf(path) >= 0)
			paths.push(openPath)
	}
	return paths
}
