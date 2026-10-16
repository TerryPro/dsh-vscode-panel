/** 兜底视图：没有哪个格式认领的文件，正文就是那块纯文本编辑器。 */

import type { FileView, FileViewBodyProps, FileViewChromeProps } from '../view-registry.ts'
import { viewModes } from '../view-registry.ts'

function PlainTextBody({ codeEditor }: FileViewBodyProps) {
  return <>{codeEditor}</>
}

/** 兜底视图没有自己的工具条。 */
function PlainTextToolbar(_props: FileViewChromeProps): null {
  return null
}

/** 判定的顺序决定谁先认领：它排在最后，所以只接别人都不要的文件。 */
export const plainTextView: FileView = {
  name: 'plainText',
  matches: () => true,
  modes: viewModes([{ name: 'source', editor: true }], 'source'),
  body: PlainTextBody,
  toolbar: PlainTextToolbar,
}
