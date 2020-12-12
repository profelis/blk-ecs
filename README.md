# blk-ecs extension

## Powerful tool to work with ecs templates

Supported features:
- go to symbols
- go to include
- go to parent template
- go to any template by string under cursor
- find all template references
- find all templates with same parameter
- autocompletion
- diagnostics file structure


Especially thanks to [eguskov](https://github.com/eguskov) for his [blktool plugin](https://github.com/eguskov/blktool). Blk grammar syntax was taken from this plugin.

### pegjs

- https://pegjs.org/
- ts plugin https://github.com/metadevpro/ts-pegjs

- npm install pegjs
- npm install ts-pegjs
- pegjs --plugin ./node_modules/ts-pegjs -o server/src/blk.ts --cache blk.pegjs
