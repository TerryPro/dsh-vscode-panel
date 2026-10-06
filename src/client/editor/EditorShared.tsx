/** Leaf presentational fallbacks for the editor surface: the empty state and image preview. */

import { FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceImageFile } from '../../shared/contracts.ts'
import css from './editor.module.css'

export function EditorEmpty({ text }: { text: string }) {
  return (
    <div className={css.editorEmpty} data-dsh-workbench-editor="">
      <FishLogo size={34} />
      <span>{text}</span>
    </div>
  )
}

export function ImagePreview({ image }: { image: WorkspaceImageFile }) {
  const source = `data:${image.mimeType};base64,${image.content}`
  return (
    <div className={css.imagePreview}>
      <img className={css.imagePreviewImage} src={source} alt={image.path} />
    </div>
  )
}
