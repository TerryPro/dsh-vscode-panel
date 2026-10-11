/**
 * The settings-dialog seat this plugin fills.
 *
 * `settings.section` is owned by DSH's own settings package, which is not a dependency
 * of this plugin, so its entry in the slot contract table is declared here rather than
 * imported — the same declaration-merging the owner packages use among themselves.
 *
 * The shape mirrors what the official built-in-plugins section registers: a list slot
 * at root scope whose entries carry an `id`, an `order`, a `label`, and a locale
 * namespace that puts a typed `t` on the component. The owner share is empty because
 * the dialog passes a section page nothing but what it injects itself.
 */

/** Empty owner share: a settings section owns its own content entirely. */
export interface SettingsSectionOwnerProps {
  /** Marker field: nothing comes from the dialog, so a child is a mistake. */
  children?: never
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'settings.section': {
      kind: 'list'
      scope: 'root'
      owner: SettingsSectionOwnerProps
    }
  }
}
