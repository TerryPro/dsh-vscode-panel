/**
 * The plugin's own page on DSH's Settings screen.
 *
 * Registered into `settings.section`, the same seat the official "built-in plugins"
 * page uses, so the entry appears in the navigation list on the left of that dialog
 * rather than as a bolt-on overlay.
 *
 * Two things about this page are deliberate. The fields come from the Host with their
 * bounds and defaults attached, so the page renders what the schema declares instead
 * of restating numbers that could drift from it. And applying a change restarts the
 * plugin, which drops every notebook kernel it owns, so the save is gated behind an
 * explicit acknowledgement rather than being a button that quietly costs the user a
 * running session.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { RiskConfirmation, SettingsValueField } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigFieldDescriptor, ConfigGroup, ConfigText } from '../../shared/config-protocol.ts'
import type { WorkbenchApi } from '../model/api.ts'
import type { WorkbenchLogger } from '../model/workbench-types.ts'
import type { WorkbenchKey } from '../core/locales.ts'
import css from './config-panel.module.css'

export interface ConfigPanelProps extends PropsLocale<'workbench'> {
  api: WorkbenchApi
  logger: WorkbenchLogger
  /**
   * Resolve one bilingual string against the language the shell is showing.
   *
   * Injected as a function rather than passed as a locale id because the fields carry
   * their copy as a `{ zh, en }` pair from the Host: the page should not re-implement
   * the fallback rules that decide which one a reader gets.
   */
  pick: (text: ConfigText) => string
}

/** Copy the page needs from the workbench dictionary. */
type Translate = ConfigPanelProps['t']

/** The order sections appear in, and the dictionary key naming each one. */
const GROUP_ORDER: readonly { group: ConfigGroup; label: WorkbenchKey }[] = [
  { group: 'kernel-count', label: 'config.group.kernel-count' },
  { group: 'kernel-lifecycle', label: 'config.group.kernel-lifecycle' },
  { group: 'kernel-output', label: 'config.group.kernel-output' },
  { group: 'kernel-discovery', label: 'config.group.kernel-discovery' },
  { group: 'files', label: 'config.group.files' },
  { group: 'git', label: 'config.group.git' },
]

/**
 * One field's draft text, for the fields the user has touched.
 *
 * A field is absent from this map until it is edited, so "changed" is presence rather
 * than a value comparison — the same rule the official form model uses, and for the
 * same reason: a draft that happens to equal the stored value is still a choice the
 * user made, and dropping it from the save would silently undo it.
 */
type Drafts = Record<string, string>

/** Whether a draft is a number this field accepts. */
function rejection(field: ConfigFieldDescriptor, text: string): boolean {
  if (text.trim() === '') return true
  const value = Number(text)
  return !Number.isInteger(value) || value < field.min || value > field.max
}

/** The value a save would send for one field, or `undefined` while its draft is not one. */
function draftValue(field: ConfigFieldDescriptor, text: string): number | undefined {
  return rejection(field, text) ? undefined : Number(text)
}

export function ConfigPanel({ api, logger, pick, t }: ConfigPanelProps) {
  const [fields, setFields] = useState<readonly ConfigFieldDescriptor[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Drafts>({})
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const [saved, setSaved] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)

  const load = useCallback(async () => {
    setError(null)
    try {
      const snapshot = await api.readPluginConfig()
      setFields(snapshot.fields)
    } catch (cause: unknown) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message)
      logger.warn(`workbench-layout: settings page could not read the configuration: ${message}`)
    }
  }, [api, logger])

  useEffect(() => { void load() }, [load])

  const grouped = useMemo(() => {
    const byGroup = new Map<ConfigGroup, ConfigFieldDescriptor[]>()
    for (const field of fields ?? []) {
      const bucket = byGroup.get(field.group)
      if (bucket === undefined) byGroup.set(field.group, [field])
      else bucket.push(field)
    }
    return byGroup
  }, [fields])

  const changedKeys = Object.keys(drafts)
  const invalid = fields === null || changedKeys.some(key => {
    const field = fields.find(candidate => candidate.key === key)
    return field !== undefined && rejection(field, drafts[key] ?? '')
  })
  // Any touched field is a change the user asked for, even one typed back to the value
  // already in force — the save writes the whole configuration, so it would restart the
  // plugin for a no-op either way, and offering that is honest about the cost.
  const dirty = changedKeys.length > 0

  const onEdit = (key: string, text: string): void => {
    setDrafts(current => ({ ...current, [key]: text }))
    setFailed(false)
    setSaved(false)
  }

  const onReset = (field: ConfigFieldDescriptor): void => {
    // Resetting stages the field's default rather than clearing the draft, because the
    // host restarts with a complete configuration: dropping the key from the save would
    // not revert it, it would just stop the page claiming anything about it.
    onEdit(field.key, String(field.default))
  }

  const apply = async (): Promise<void> => {
    if (fields === null) return
    setConfirming(false)
    setSaving(true)
    setFailed(false)
    const body: Record<string, number> = {}
    for (const field of fields) {
      const draft = drafts[field.key]
      const value = draft === undefined ? field.value : draftValue(field, draft)
      // A draft that became invalid after the check still cannot be sent, so the last
      // known-good value stands rather than a value the schema would reject.
      body[field.key] = value ?? field.value
    }
    try {
      const snapshot = await api.updatePluginConfig(body)
      // The host answers before it restarts, so this reply is the accepted set.
      setFields(snapshot.fields)
      setDrafts({})
      setSaved(true)
    } catch (cause: unknown) {
      const message = cause instanceof Error ? cause.message : String(cause)
      logger.warn(`workbench-layout: settings page could not apply the configuration: ${message}`)
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  const onSave = (): void => {
    if (dirty && !invalid) setConfirming(true)
  }

  return (
    <section className={css.page}>
      <h2 className={css.heading}>{t('config.title')}</h2>
      <p className={css.intro}>{t('config.intro')}</p>

      {error !== null && (
        <div className={css.errorState} role="alert">
          <span>{t('config.unavailable', { message: error })}</span>
          <button type="button" className={css.retry} onClick={() => { void load() }}>{t('config.retry')}</button>
        </div>
      )}

      {fields === null && error === null && <p className={css.intro}>{t('config.loading')}</p>}

      {fields !== null && GROUP_ORDER.map(({ group, label }) => {
        const rows = grouped.get(group)
        if (rows === undefined || rows.length === 0) return null
        return (
          <div key={group} className={css.group}>
            <h3 className={css.groupTitle}>{t(label)}</h3>
            {rows.map(field => {
              const draft = drafts[field.key]
              const text = draft ?? String(field.value)
              const rejected = rejection(field, text)
              return (
                <SettingsValueField
                  key={field.key}
                  id={`workbench-config-${field.key}`}
                  label={pick(field.title)}
                  hint={hintOf(field, t)}
                  help={{ label: pick(field.description), content: rangeOf(field, t) }}
                  text={text}
                  numeric
                  disabled={saving}
                  // Presence in the draft map, not a value comparison: a field the user
                  // typed back to what it already held is still one they touched, and the
                  // reset control beside it is how they say otherwise.
                  overridden={draft !== undefined}
                  invalid={rejected}
                  invalidLabel={t('config.invalid', { min: String(field.min), max: String(field.max) })}
                  overriddenLabel={t('config.overridden')}
                  resetLabel={t('config.reset')}
                  onEdit={value => { onEdit(field.key, value) }}
                  onReset={() => { onReset(field) }}
                />
              )
            })}
          </div>
        )
      })}

      <div className={css.footer}>
        {failed && <span className={css.failed}>{t('config.saveFailed')}</span>}
        {saved && <span className={css.saved}>{t('config.saved')}</span>}
        <button
          type="button"
          className={css.save}
          disabled={!dirty || invalid || saving || saved}
          onClick={onSave}
        >
          {saving ? t('config.saving') : t('config.save')}
        </button>
      </div>

      <RiskConfirmation
        open={confirming}
        title={t('config.restartTitle')}
        description={t('config.restartBody')}
        acknowledgeLabel={t('config.restartAck')}
        cancelLabel={t('config.cancel')}
        closeLabel={t('config.cancel')}
        confirmLabel={t('config.confirm')}
        acknowledged={acknowledged}
        onAcknowledgedChange={setAcknowledged}
        onCancel={() => { setConfirming(false); setAcknowledged(false) }}
        onConfirm={() => { setAcknowledged(false); void apply() }}
      />
    </section>
  )
}

/** The line under a control: what the field reverts to, with its unit. */
function hintOf(field: ConfigFieldDescriptor, t: Translate): string {
  return t('config.defaultHint', { value: `${formatValue(field.default, field.unit)}${unitSuffix(field, t)}` })
}

/** Disclosed by the control's information button: the schema's own bounds. */
function rangeOf(field: ConfigFieldDescriptor, t: Translate): string {
  return `${formatValue(field.min, field.unit)} – ${formatValue(field.max, field.unit)}${unitSuffix(field, t)}`
}

/**
 * The unit label beside a number.
 *
 * Every unit gets one, including a plain count: "Default 1,000 items" and "默认 1000 个"
 * both read better than a bare number, and a classifier is required in Chinese.
 */
function unitSuffix(field: ConfigFieldDescriptor, t: Translate): string {
  const key = field.unit === 'bytes' ? 'config.unit.bytes' : field.unit === 'ms' ? 'config.unit.ms' : 'config.unit.count'
  return ` ${t(key)}`
}

function formatValue(value: number, unit: ConfigFieldDescriptor['unit']): string {
  if (unit !== 'bytes') return value.toLocaleString('en-US')
  const mib = value / (1024 * 1024)
  return mib >= 1 ? `${Number(mib.toFixed(2))} MiB` : `${Math.round(value / 1024)} KiB`
}
