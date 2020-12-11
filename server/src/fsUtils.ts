import { readdir, statSync } from 'fs'
import { resolve } from 'path'

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
