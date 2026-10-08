import { parseDocument, isMap, isScalar } from 'yaml'
const src = `base: &b\n  x: 1\ncopy: *b\nscript: |\n  a\n  b\nfolded: >-\n  c\n  d\nnum: 42\nflag: yes\nnil: ~\ntagged: !!str 7\n`
const doc = parseDocument(src)
const items = doc.contents.items
for (const p of items) {
  const v = p.value
  console.log(p.key.source, '| anchor=', JSON.stringify(v.anchor), '| tag=', JSON.stringify(v.tag), '| type=', v.type, '| range=', JSON.stringify(v.range), '| src=', JSON.stringify(v.source), '| value=', JSON.stringify(v.value))
}
const bad = parseDocument(`a: 1\n b: 2\n`, { prettyErrors: true })
console.log('errors', bad.errors.map(e => e.message), 'contents kind', bad.contents?.constructor?.name, JSON.stringify(bad.contents?.range))
const empty = parseDocument('# only comment\n')
console.log('empty contents', empty.contents, 'errors', empty.errors.length)
