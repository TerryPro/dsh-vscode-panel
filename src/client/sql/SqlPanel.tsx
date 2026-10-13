/**
 * The SQL sidebar panel: the connection and schema of the SQL notebook the reader is in.
 *
 * Which notebook it describes is the *active* `.sqlnb` tab, because a connection belongs to a
 * notebook (ADR 0002) and this panel is a side view of the work in the middle column. With no SQL
 * notebook open it says that rather than guessing at "the only connection in this workspace" — the
 * same rule the Host applies when a request names no notebook.
 */

import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import css from './sql-panel.module.css'

export interface SqlPanelProps {
  t: TranslateNS<'workbench'>
}

export function SqlPanel({ t }: SqlPanelProps) {
  return (
    <div className={css.panelBody}>
      <header className={css.panelHeader} data-dsh-workbench-panel-header="">
        <span className={css.panelTitle}>{t('sqlnotebook.panelTitle')}</span>
      </header>
      <div className={css.panelEmpty}>{t('sqlnotebook.panelNoNotebook')}</div>
    </div>
  )
}
